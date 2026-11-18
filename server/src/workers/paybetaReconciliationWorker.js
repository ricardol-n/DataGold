
const crypto = require("crypto");
const Transaction = require("../models/transaction");

const {
  refundConfirmedFailure,
} = require("../services/paybetaRefundService");

const BASE_URLS = {
  sandbox: "https://api.sandbox.paybeta.ng",
  production: "https://api.paybeta.ng",
};

const RETRY_DELAY_MS = 2 * 60 * 1000;
const LEASE_DURATION_MS = 60 * 1000;
const POLL_INTERVAL_MS = 30 * 1000;
const BATCH_SIZE = 10;

let workerRunning = false;
let interval = null;

async function scheduleRetry(transaction, leaseToken, details = {}) {
  await Transaction.updateOne(
    {
      _id: transaction._id,
      status: "pending",
      "metadata.reconcileLeaseToken": leaseToken,
    },
    {
      $set: {
        "metadata.reconcileNextAt": new Date(
          Date.now() + RETRY_DELAY_MS
        ),
        "metadata.reconcileLastCheckedAt": new Date(),
        ...details,
      },
    }
  );
}

async function queryPaybeta(reference) {
  const mode = process.env.PAYBETA_MODE;
  const baseUrl = BASE_URLS[mode];

  const configuredUrl = (
    process.env.PAYBETA_BASE_URL || ""
  ).replace(/\/+$/, "");

  const apiKey = process.env.PAYBETA_API_KEY;

  if (!baseUrl || configuredUrl !== baseUrl || !apiKey) {
    throw new Error(
      "Paybeta reconciliation configuration is invalid."
    );
  }

  const response = await fetch(
    `${baseUrl}/v2/transaction/query`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "P-API-KEY": apiKey,
      },
      body: JSON.stringify({ reference }),
      signal: AbortSignal.timeout(10000),
    }
  );

  const raw = await response.text();

  let result;

  try {
    result = JSON.parse(raw);
  } catch {
    result = null;
  }

  if (!response.ok || !result) {
    throw new Error(
      `Paybeta query unsuccessful. HTTP ${response.status}`
    );
  }

  return result;
}

async function processTransaction(transaction, leaseToken) {
  const reference = transaction.reference;

  try {
    const result = await queryPaybeta(reference);

    const providerCode = String(result?.code ?? "");

    // Confirmed final failure: use the existing
    // atomic refund service.
    if (providerCode === "02") {
      const refundResult = await refundConfirmedFailure(
        transaction._id,
        reference
      );

      if (!refundResult.refunded) {
        throw new Error("Confirmed failure refund is unresolved.");
      }

      await Transaction.updateOne(
        {
          _id: transaction._id,
          type: "data_purchase",
          "metadata.reconcileLeaseToken": leaseToken,
        },
        {
          $set: {
            "metadata.reconcileLastCheckedAt": new Date(),
            "metadata.reconcileLastOutcome": "failed_refunded",
          },
        }
      );

      console.log(
        `Reconciled failed purchase and refund: ${reference}`
      );

      return;
    }

    const paymentStatus = String(
      result?.data?.paymentStatus || ""
    ).toLowerCase();

    // Complete only when Paybeta confirms delivery.
    if (
      providerCode === "00" &&
      result?.status === "successful" &&
      paymentStatus === "delivered"
    ) {
      const updated = await Transaction.updateOne(
        {
          _id: transaction._id,
          type: "data_purchase",
          status: "pending",
          "metadata.reconcileLeaseToken": leaseToken,
        },
        {
          $set: {
            status: "completed",
            "metadata.providerStatus": result.status,
            "metadata.paymentStatus":
              result.data.paymentStatus,
            "metadata.providerTransactionId":
              result.data.transactionId || null,
            "metadata.deliveryConfirmedAt": new Date(),
            "metadata.reconcileLastCheckedAt": new Date(),
            "metadata.reconcileLastOutcome": "delivered",
          },
        }
      );

      if (updated.modifiedCount === 1) {
        console.log(
          `Reconciliation confirmed delivery: ${reference}`
        );
      }

      return;
    }

    // Pending, not found, and unknown responses remain pending.
    // Never refund these automatically.
    await scheduleRetry(transaction, leaseToken, {
      "metadata.providerQueryCode": providerCode || null,
      "metadata.providerMessage":
        result?.message || "Awaiting delivery confirmation.",
      "metadata.reconcileLastOutcome": "unresolved",
    });

    console.log(
      `Purchase still unresolved; retry scheduled: ${reference}`
    );
  } catch (error) {
    console.error("Transaction reconciliation failed:", {
      reference,
      message: error.message,
    });

    try {
      await scheduleRetry(transaction, leaseToken, {
        "metadata.reconcileLastOutcome": "query_error",
        "metadata.reconcileLastError":
          error.message.slice(0, 250),
      });
    } catch (retryError) {
      console.error(
        "Unable to schedule reconciliation retry:",
        retryError.message
      );
    }
  } finally {
    // Only the worker that owns this token can release its lease.
    await Transaction.updateOne(
      {
        _id: transaction._id,
        "metadata.reconcileLeaseToken": leaseToken,
      },
      {
        $unset: {
          "metadata.reconcileLeaseUntil": "",
          "metadata.reconcileLeaseToken": "",
        },
      }
    ).catch((error) => {
      console.error(
        "Unable to release reconciliation lease:",
        error.message
      );
    });
  }
}

async function runReconciliationCycle() {
  if (workerRunning) {
    return;
  }

  workerRunning = true;

  try {
    const now = new Date();

    const eligibleBefore = new Date(
      now.getTime() - RETRY_DELAY_MS
    );

    const candidates = await Transaction.find({
      type: "data_purchase",
      status: "pending",
      "metadata.provider": "paybeta",
      createdAt: { $lte: eligibleBefore },
      $and: [
        {
          $or: [
            { "metadata.reconcileNextAt": { $exists: false } },
            { "metadata.reconcileNextAt": { $lte: now } },
          ],
        },
        {
          $or: [
            { "metadata.reconcileLeaseUntil": { $exists: false } },
            { "metadata.reconcileLeaseUntil": { $lte: now } },
          ],
        },
      ],
    })
      .select("_id")
      .sort({ createdAt: 1 })
      .limit(BATCH_SIZE)
      .lean();

    for (const candidate of candidates) {
      const claimTime = new Date();
      const leaseToken = crypto.randomUUID();

      // Atomically claim the transaction.
      const transaction = await Transaction.findOneAndUpdate(
        {
          _id: candidate._id,
          type: "data_purchase",
          status: "pending",
          $and: [
            {
              $or: [
                { "metadata.reconcileNextAt": { $exists: false } },
                {
                  "metadata.reconcileNextAt": {
                    $lte: claimTime,
                  },
                },
              ],
            },
            {
              $or: [
                {
                  "metadata.reconcileLeaseUntil": {
                    $exists: false,
                  },
                },
                {
                  "metadata.reconcileLeaseUntil": {
                    $lte: claimTime,
                  },
                },
              ],
            },
          ],
        },
        {
          $set: {
            "metadata.reconcileLeaseUntil": new Date(
              claimTime.getTime() + LEASE_DURATION_MS
            ),
            "metadata.reconcileLeaseToken": leaseToken,
          },
          $inc: {
            "metadata.reconcileAttempts": 1,
          },
        },
        { new: true }
      );

      if (transaction) {
        await processTransaction(transaction, leaseToken);
      }
    }
  } catch (error) {
    console.error(
      "Paybeta reconciliation cycle failed:",
      error.message
    );
  } finally {
    workerRunning = false;
  }
}

function startPaybetaReconciliationWorker() {
  if (interval) {
    return;
  }

  console.log("Paybeta reconciliation worker started.");

  runReconciliationCycle();

  interval = setInterval(
    runReconciliationCycle,
    POLL_INTERVAL_MS
  );
}

module.exports = {
  startPaybetaReconciliationWorker,
  runReconciliationCycle,
};
