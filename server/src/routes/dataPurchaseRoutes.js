
const express = require("express");
const crypto = require("crypto");
const mongoose = require("mongoose");

const router = express.Router();
const { protect } = require("../middleware/authMiddleware");

const User = require("../models/user");
const Transaction = require("../models/transaction");
const {
  refundConfirmedFailure,
} = require("../services/paybetaRefundService");

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


async function getPaybetaPlans(baseUrl, apiKey, service) {
  const url = new URL(`${baseUrl}/v2/data-bundle/list`);
  url.searchParams.set("service", service);

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "P-API-KEY": apiKey,
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

    // Prevent duplicate submissions.
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

    const apiKey = process.env.PAYBETA_API_KEY;
    const secret = process.env.PAYBETA_SECRET_KEY;

    if (!baseUrl || configuredUrl !== baseUrl || !apiKey || !secret) {
      return res.status(503).json({
        success: false,
        message: "Paybeta is not configured correctly.",
      });
    }

    // Always obtain the price from Paybeta.
    const packages = await getPaybetaPlans(
      baseUrl,
      apiKey,
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

    // Reserve wallet funds and create the pending order atomically.
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

    // Submit the purchase only once.
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
            "P-API-KEY": apiKey,
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
      // The provider may have received the request.
      // Never automatically submit it again or refund yet.
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

    // Record the initial provider response, but do not treat
    // purchase acceptance as proof of successful delivery.
    await Transaction.updateOne(
      { reference, status: "pending" },
      {
        $set: {
          "metadata.providerPurchaseStatus": result?.status || null,
          "metadata.providerPurchaseMessage": result?.message || null,
          "metadata.providerPurchaseHttpStatus": response.status,
        },
      }
    );

    // Query Paybeta for the actual transaction outcome.
    let queryResponse;
    let queryResult;

    try {
      queryResponse = await fetch(
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

      const queryRaw = await queryResponse.text();

      try {
        queryResult = JSON.parse(queryRaw);
      } catch {
        queryResult = null;
      }
    } catch (error) {
      console.error("Paybeta transaction query failed:", {
        reference,
        error: error.message,
      });

      return res.status(202).json({
        success: true,
        message: "Your order is awaiting provider confirmation.",
        order: { reference, status: "pending", amount },
      });
    }

    if (!queryResponse.ok || !queryResult) {
      return res.status(202).json({
        success: true,
        message: "Your order is awaiting provider confirmation.",
        order: { reference, status: "pending", amount },
      });
    }

    // Refund only a provider-confirmed final failure.
    if (String(queryResult.code) === "02") {
      const transaction = await Transaction.findOne({
        reference,
        type: "data_purchase",
      });

      if (!transaction) {
        throw new Error("Purchase transaction not found during refund.");
      }

      const refundResult = await refundConfirmedFailure(
        transaction._id,
        reference
      );

      if (!refundResult.refunded) {
        return res.status(503).json({
          success: false,
          message: "The confirmed failure requires refund reconciliation.",
          order: { reference, status: "pending", amount },
        });
      }

      return res.status(502).json({
        success: false,
        message: "The provider confirmed failure. Your wallet has been refunded.",
        order: { reference, status: "failed", amount },
      });
    }

    const paymentStatus = String(
      queryResult.data?.paymentStatus || ""
    ).toLowerCase();

    // Complete only after Paybeta confirms actual delivery.
    if (
      String(queryResult.code) === "00" &&
      queryResult.status === "successful" &&
      paymentStatus === "delivered"
    ) {
      const updated = await Transaction.findOneAndUpdate(
        {
          reference,
          status: "pending",
        },
        {
          $set: {
            status: "completed",
            "metadata.providerStatus": queryResult.status,
            "metadata.paymentStatus": queryResult.data.paymentStatus,
            "metadata.providerTransactionId":
              queryResult.data.transactionId || null,
            "metadata.deliveryConfirmedAt": new Date(),
          },
        },
        { new: true }
      );

      if (!updated) {
        const current = await Transaction.findOne({ reference });

        return res.status(200).json({
          success: true,
          message: "Your order has already been reconciled.",
          order: {
            reference,
            status: current?.status || "pending",
            amount,
          },
        });
      }

      return res.status(200).json({
        success: true,
        message: "Data delivery confirmed successfully.",
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

    // Pending, not found, or unknown results remain unresolved.
    // The wallet reservation is retained.
    await Transaction.updateOne(
      { reference, status: "pending" },
      {
        $set: {
          "metadata.providerQueryCode": queryResult.code || null,
          "metadata.providerMessage":
            queryResult.message ||
            result?.message ||
            "Awaiting delivery confirmation.",
        },
      }
    );

    return res.status(202).json({
      success: true,
      message: "Your order is awaiting provider confirmation.",
      order: { reference, status: "pending", amount },
    });
  } catch (error) {
    // Handle a concurrent duplicate order safely.
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
