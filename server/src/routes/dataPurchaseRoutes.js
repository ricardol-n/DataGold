
const express = require("express");
const crypto = require("crypto");
const mongoose = require("mongoose");

const router = express.Router();
const { protect } = require("../middleware/authMiddleware");

const User = require("../models/user");
const Transaction = require("../models/transaction");

const NETWORKS = {
  mtn: "mtn_data",
  airtel: "airtel_data",
  glo: "glo_data",
  "9mobile": "9mobile_data",
};

const BASE_URLS = {
  sandbox: "https://api.sandbox.paybeta.ng",
  production: "https://api.paybeta.ng",
};

function makeReference(userId, idempotencyKey) {
  const digest = crypto
    .createHash("sha256")
    .update(`${userId}:${idempotencyKey}`)
    .digest("hex")
    .slice(0, 32);

  return `DG${digest}`;
}


async function getPaybetaPlans(baseUrl, secret, service) {
  const url = new URL(`${baseUrl}/v2/data-bundle/list`);
  url.searchParams.set("service", service);

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "P-API-KEY": secret,
    },
    signal: AbortSignal.timeout(15000),
  });

  const raw = await response.text();

  let result;
  try {
    result = JSON.parse(raw);
  } catch {
    result = null;
  }

  if (
    !response.ok ||
    result?.status !== "successful" ||
    !Array.isArray(result?.data?.packages)
  ) {
    const error = new Error(
      "Unable to verify the selected data plan."
    );
    error.status = 502;

    console.error("Paybeta plan verification failed:", {
      httpStatus: response.status,
      providerStatus: result?.status,
      providerMessage: result?.message,
    });

    throw error;
  }

  return result.data.packages;
}


async function refundConfirmedFailure(transactionId, reference) {
  const session = await mongoose.startSession();

  try {
    await session.withTransaction(async () => {
      const transaction = await Transaction.findOne({
        _id: transactionId,
        status: "pending",
      }).session(session);

      // A completed/refunded transaction must never be refunded twice.
      if (!transaction) return;

      const refundReference = `${reference}-refund`;

      const existingRefund = await Transaction.findOne({
        reference: refundReference,
      }).session(session);

      if (existingRefund) return;

      await User.updateOne(
        { _id: transaction.user },
        { $inc: { walletBalance: transaction.amount } },
        { session }
      );

      await Transaction.create(
        [
          {
            user: transaction.user,
            type: "refund",
            amount: transaction.amount,
            status: "completed",
            reference: refundReference,
            description: "Refund for failed data purchase",
            metadata: {
              originalReference: reference,
            },
          },
        ],
        { session }
      );

      transaction.status = "failed";
      transaction.metadata = {
        ...(transaction.metadata || {}),
        refunded: true,
      };

      await transaction.save({ session });
    });
  } finally {
    await session.endSession();
  }
}


router.get("/", protect, async (req, res) => {
  try {
    const page = Math.max(
      1,
      Number.parseInt(req.query.page, 10) || 1
    );

    const limit = Math.min(
      50,
      Math.max(1, Number.parseInt(req.query.limit, 10) || 10)
    );

    const filter = {
      user: req.user._id,
      type: "data_purchase",
    };

    const [transactions, total] = await Promise.all([
      Transaction.find(filter)
        .select(
          "reference amount status description metadata createdAt updatedAt"
        )
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),

      Transaction.countDocuments(filter),
    ]);

    const orders = transactions.map((transaction) => ({
      reference: transaction.reference,
      amount: transaction.amount,
      status: transaction.status,
      description: transaction.description,
      network: transaction.metadata?.network || "",
      plan:
        transaction.metadata?.planDescription || "",
      phone: transaction.metadata?.phone || "",
      createdAt: transaction.createdAt,
      updatedAt: transaction.updatedAt,
    }));

    return res.json({
      success: true,
      orders,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("Order history lookup failed:", error.message);

    return res.status(500).json({
      success: false,
      message: "Unable to retrieve order history.",
    });
  }
});
 

router.get("/:reference", protect, async (req, res) => {
  try {
    const reference = String(req.params.reference || "").trim();

    if (!/^DG[a-f0-9]{32}$/.test(reference)) {
      return res.status(400).json({
        success: false,
        message: "Invalid order reference.",
      });
    }

    const transaction = await Transaction.findOne({
      user: req.user._id,
      reference,
      type: "data_purchase",
    }).select(
      "reference amount status description metadata createdAt updatedAt"
    );

    if (!transaction) {
      return res.status(404).json({
        success: false,
        message: "Order not found.",
      });
    }

    return res.json({
      success: true,
      order: {
        reference: transaction.reference,
        amount: transaction.amount,
        status: transaction.status,
        description: transaction.description,
        network: transaction.metadata?.network,
        plan: transaction.metadata?.planDescription,
        phone: transaction.metadata?.phone,
        createdAt: transaction.createdAt,
        updatedAt: transaction.updatedAt,
      },
    });
  } catch (error) {
    console.error("Order status lookup failed:", error.message);

    return res.status(500).json({
      success: false,
      message: "Unable to retrieve order status.",
    });
  }
});


router.post("/", protect, async (req, res) => {
  let reference;

  try {
    const network = String(req.body.network || "")
      .trim()
      .toLowerCase();

    const planCode = String(req.body.planCode || "").trim();
    const phone = String(req.body.phone || "").trim();

    // Require a stable key for retries of the same order.
    const idempotencyKey = String(
      req.get("Idempotency-Key") || ""
    ).trim();

    if (!NETWORKS[network]) {
      return res.status(400).json({
        success: false,
        message: "Select a supported network.",
      });
    }

    if (!planCode || planCode.length > 150) {
      return res.status(400).json({
        success: false,
        message: "Select a valid data plan.",
      });
    }

    if (!/^0[789][01]\d{8}$/.test(phone)) {
      return res.status(400).json({
        success: false,
        message: "Enter a valid 11-digit Nigerian phone number.",
      });
    }

    if (!/^[a-zA-Z0-9-]{16,100}$/.test(idempotencyKey)) {
      return res.status(400).json({
        success: false,
        message: "A valid Idempotency-Key header is required.",
      });
    }

    reference = makeReference(req.user._id, idempotencyKey);

    // A retry of the same order must not submit another purchase.
    const existing = await Transaction.findOne({ reference });

    if (existing) {
      return res.status(200).json({
        success: true,
        message: "This order has already been received.",
        order: {
          reference: existing.reference,
          status: existing.status,
          amount: existing.amount,
        },
      });
    }

    // Keep this flag false until Paybeta authentication and
    // the sandbox purchase workflow have been verified.
    if (process.env.PAYBETA_PURCHASES_ENABLED !== "true") {
      return res.status(503).json({
        success: false,
        message: "Data purchases are temporarily disabled.",
      });
    }

    const mode = process.env.PAYBETA_MODE;
    const baseUrl = BASE_URLS[mode];
    const configuredUrl = (
      process.env.PAYBETA_BASE_URL || ""
    ).replace(/\/+$/, "");

    const secret = process.env.PAYBETA_SECRET_KEY;

    if (!baseUrl || configuredUrl !== baseUrl || !secret) {
      return res.status(503).json({
        success: false,
        message: "Paybeta is not configured correctly.",
      });
    }

    // Never accept the price supplied by the browser.
    const packages = await getPaybetaPlans(
      baseUrl,
      secret,
      NETWORKS[network]
    );

    const plan = packages.find(
      (item) => item.code === planCode
    );

    const amount = Number(plan?.price);

    if (!plan || !Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: "This data plan is unavailable. Refresh the plans and try again.",
      });
    }

    // Reserve funds and record the order atomically.
    // MongoDB must support transactions (Atlas does).
    const session = await mongoose.startSession();

    try {
      await session.withTransaction(async () => {
        const user = await User.findOneAndUpdate(
          {
            _id: req.user._id,
            walletBalance: { $gte: amount },
          },
          {
            $inc: { walletBalance: -amount },
          },
          {
            new: true,
            session,
          }
        );

        if (!user) {
          const error = new Error("Insufficient wallet balance.");
          error.status = 400;
          throw error;
        }

        await Transaction.create(
          [
            {
              user: user._id,
              type: "data_purchase",
              amount,
              status: "pending",
              reference,
              description: `${network.toUpperCase()} data for ${phone}`,
              metadata: {
                network,
                service: NETWORKS[network],
                planCode,
                planDescription: plan.description,
                phone,
                provider: "paybeta",
              },
            },
          ],
          { session }
        );
      });
    } finally {
      await session.endSession();
    }

    // The provider call happens AFTER the wallet reservation commits.
    // Never automatically repeat this request after an uncertain result.
    let response;
    let result;

    try {
      response = await fetch(
        `${baseUrl}/v2/data-bundle/purchase`,
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "P-API-KEY": secret,
          },
          body: JSON.stringify({
            service: NETWORKS[network],
            amount,
            phoneNumber: phone,
            code: planCode,
            reference,
          }),
          signal: AbortSignal.timeout(20000),
        }
      );

      const raw = await response.text();

      try {
        result = JSON.parse(raw);
      } catch {
        result = null;
      }
    } catch (error) {
      // A timeout or connection failure is ambiguous: Paybeta
      // might have processed the request. Keep funds reserved.
      console.error("Paybeta purchase outcome is uncertain:", {
        reference,
        error: error.message,
      });

      return res.status(202).json({
        success: true,
        message: "Your order is being verified. Do not submit it again.",
        order: { reference, status: "pending", amount },
      });
    }

    const providerStatus = result?.status;

    if (providerStatus === "successful") {
      await Transaction.updateOne(
        { reference, status: "pending" },
        {
          $set: {
            status: "completed",
            "metadata.providerReference": result?.data?.reference,
            "metadata.providerTransactionId": result?.data?.transactionId,
            "metadata.providerMessage": result?.message,
          },
        }
      );

      return res.status(200).json({
        success: true,
        message: "Data purchase successful.",
        order: {
          reference,
          status: "completed",
          amount,
          phone,
          network,
          plan: plan.description,
        },
      });
    }

    if (providerStatus === "failed") {
      const transaction = await Transaction.findOne({ reference });

      if (transaction) {
        await refundConfirmedFailure(transaction._id, reference);
      }

      return res.status(502).json({
        success: false,
        message: "The provider reported a failed purchase. Check your order status before trying again.",
        order: { reference, status: "failed" },
      });
    }

    // Pending, unknown status, or an unexpected HTTP response:
    // retain the pending order and funds until reconciliation.
    await Transaction.updateOne(
      { reference, status: "pending" },
      {
        $set: {
          "metadata.providerMessage":
            result?.message || `Unexpected HTTP ${response.status}`,
        },
      }
    );

    return res.status(202).json({
      success: true,
      message: "Your order is awaiting provider confirmation.",
      order: { reference, status: "pending", amount },
    });
  } catch (error) {
    
    // A concurrent request may have created this order first.
    // Return that order instead of treating the retry as a server error.
    if (error?.code === 11000 && reference) {
      try {
        const existing = await Transaction.findOne({
          user: req.user._id,
          reference,
          type: "data_purchase",
        });

        if (existing) {
          return res.status(200).json({
            success: true,
            message: "This order has already been received.",
            order: {
              reference: existing.reference,
              status: existing.status,
              amount: existing.amount,
            },
          });
        }
      } catch (lookupError) {
        console.error(
          "Duplicate order lookup failed:",
          lookupError.message
        );
      }
    }

    if (error.status === 400) {
      return res.status(400).json({
        success: false,
        message: error.message,
      });
    }

    console.error("Data purchase error:", {
      reference,
      message: error.message,
    });

    return res.status(error.status || 500).json({
      success: false,
      message: error.status === 502
        ? error.message
        : "Unable to process the data purchase.",
    });
  }
});

module.exports = router;
