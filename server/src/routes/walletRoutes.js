
const express = require("express");
const router = express.Router();

const { protect } = require("../middleware/authMiddleware");
const Transaction = require("../models/transaction");
const mongoose = require("mongoose");
const User = require("../models/user");

const crypto = require("crypto");

// GET /api/wallet
// View the authenticated user's wallet balance.
router.get("/", protect, async (req, res, next) => {
  try {
    res.json({
      success: true,
      wallet: {
        balance: req.user.walletBalance ?? 0,
        currency: req.user.walletCurrency || "NGN",
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/wallet/transactions
// View only the authenticated user's transactions.
router.get("/transactions", protect, async (req, res, next) => {
  try {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(
      50,
      Math.max(1, Number.parseInt(req.query.limit, 10) || 10)
    );

    const filter = { user: req.user._id };

    const [transactions, total] = await Promise.all([
      Transaction.find(filter)
        .select("type amount status reference description createdAt")
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Transaction.countDocuments(filter),
    ]);

    res.json({
      success: true,
      transactions,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    next(error);
  }
});

router.post("/fund", protect, async (req, res, next) => {
  let transaction;

  try {
    const secretKey = process.env.PAYSTACK_SECRET_KEY;
    const callbackUrl = process.env.PAYSTACK_CALLBACK_URL;

    if (!secretKey || !secretKey.startsWith("sk_test_")) {
      return res.status(503).json({
        message: "Paystack test mode is not configured correctly.",
      });
    }

    if (!callbackUrl) {
      return res.status(503).json({
        message: "Payment callback URL is not configured.",
      });
    }

    const amount = req.body?.amount;

    // Accept whole amounts in naira only, within the configured limits.
    if (
      typeof amount !== "number" ||
      !Number.isSafeInteger(amount) ||
      amount < 100 ||
      amount > 5_000_000
    ) {
      return res.status(400).json({
        message: "Enter an amount between ₦100 and ₦5,000,000 in whole naira.",
      });
    }

    if (!req.user.email) {
      return res.status(400).json({
        message: "Your account needs a valid email address to make a payment.",
      });
    }

    // Paystack references permit alphanumeric characters and hyphens.
    const reference = `DG-${crypto.randomBytes(16).toString("hex")}`;

    // Save the pending deposit before contacting Paystack.
    transaction = await Transaction.create({
      user: req.user._id,
      type: "deposit",
      amount,
      status: "pending",
      reference,
      description: "DataGold wallet funding",
      metadata: {
        provider: "paystack",
        currency: "NGN",
      },
    });

    const paystackResponse = await fetch(
      "https://api.paystack.co/transaction/initialize",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secretKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email: req.user.email,
          amount: String(amount * 100),
          currency: "NGN",
          reference,
          callback_url: callbackUrl,
          channels: ["card", "bank", "bank_transfer"],
          metadata: {
            userId: String(req.user._id),
            purpose: "datagold_wallet_funding",
          },
        }),
        signal: AbortSignal.timeout(15000),
      }
    );

    const result = await paystackResponse.json();

    
if (
  !paystackResponse.ok ||
  !result.status ||
  !result.data?.authorization_url ||
  result.data.reference !== reference
) {
  console.error("Paystack initialization failed:", {
    httpStatus: paystackResponse.status,
    message: result?.message,
    referenceReturned: result?.data?.reference,
    referenceExpected: reference,
  });

  transaction.status = "failed";
  await transaction.save();

  return res.status(502).json({
    message: "Could not initialize payment. Please try again.",
  });
}


    return res.status(201).json({
      success: true,
      message: "Payment initialized. Continue to Paystack checkout.",
      payment: {
        reference,
        amount,
        currency: "NGN",
        authorizationUrl: result.data.authorization_url,
      },
    });
  } catch (error) {
    // If a request times out, Paystack may still have created the payment.
    // Leave the transaction pending for later verification rather than
    // assuming the payment failed.
    if (transaction && error.name !== "AbortError" &&
        error.name !== "TimeoutError") {
      try {
        transaction.status = "failed";
        await transaction.save();
      } catch (saveError) {
        console.error("Could not update deposit status:", saveError.message);
      }
    }

    next(error);
  }
});


/**
 * POST /api/wallet/fund/verify
 *
 * Verify a Paystack payment and credit the user's wallet once.
 */
router.post("/fund/verify", protect, async (req, res, next) => {
  const reference = req.body?.reference;

  if (
    typeof reference !== "string" ||
    !/^DG-[a-f0-9]{32}$/.test(reference)
  ) {
    return res.status(400).json({
      message: "A valid DataGold payment reference is required.",
    });
  }

  const secretKey = process.env.PAYSTACK_SECRET_KEY;

  if (!secretKey || !secretKey.startsWith("sk_test_")) {
    return res.status(503).json({
      message: "Paystack test mode is not configured correctly.",
    });
  }

  try {
    // Only allow users to verify their own deposit.
    const transaction = await Transaction.findOne({
      user: req.user._id,
      reference,
      type: "deposit",
    });

    if (!transaction) {
      return res.status(404).json({
        message: "Payment reference not found.",
      });
    }

    // Idempotency: never credit a completed deposit a second time.
    if (transaction.status === "completed") {
      const user = await User.findById(req.user._id).select(
        "walletBalance walletCurrency"
      );

      return res.json({
        success: true,
        message: "This payment has already been credited.",
        wallet: {
          balance: user?.walletBalance ?? 0,
          currency: user?.walletCurrency || "NGN",
        },
      });
    }

    if (transaction.status !== "pending") {
      return res.status(409).json({
        message: "This payment is not awaiting verification.",
      });
    }

    // Ask Paystack directly; never trust a browser's payment status.
    const response = await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${secretKey}`,
        },
        signal: AbortSignal.timeout(15000),
      }
    );

    const result = await response.json();
    const payment = result?.data;

    if (!response.ok || !result?.status || !payment) {
      console.error("Paystack verification request failed:", {
        httpStatus: response.status,
        message: result?.message,
        reference,
      });

      return res.status(502).json({
        message: "Unable to verify this payment right now. Please retry.",
      });
    }

    // Verify all payment details against our stored deposit.
    const validPayment =
      payment.status === "success" &&
      payment.reference === transaction.reference &&
      payment.currency === "NGN" &&
      payment.amount === transaction.amount * 100 &&
      payment.domain === "test" &&
      String(payment.customer?.email || "").toLowerCase() ===
        String(req.user.email).toLowerCase();

    if (!validPayment) {
      return res.status(409).json({
        message:
          "Payment is not successful or its details do not match. The wallet has not been credited.",
      });
    }

    // Atomically mark the deposit completed and increment the balance.
    // Both changes succeed together, or neither change is committed.
    const session = await mongoose.startSession();
    let credited = false;

    try {
      await session.withTransaction(async () => {
        // Reset in case MongoDB retries this transaction callback.
        credited = false;

        const updated = await Transaction.findOneAndUpdate(
          {
            _id: transaction._id,
            user: req.user._id,
            status: "pending",
          },
          {
            $set: {
              status: "completed",
              "metadata.paystackTransactionId": String(payment.id),
              "metadata.paymentChannel": payment.channel || "unknown",
              "metadata.paidAt": payment.paid_at || null,
            },
          },
          {
            new: true,
            session,
          }
        );

        // Another verification request may have won the race.
        if (!updated) return;

        const balanceUpdate = await User.updateOne(
          { _id: req.user._id },
          { $inc: { walletBalance: transaction.amount } },
          { session }
        );

        if (balanceUpdate.matchedCount !== 1) {
          throw new Error("Wallet owner was not found.");
        }

        credited = true;
      });
    } finally {
      await session.endSession();
    }

    // If another request completed it first, don't credit it again.
    if (!credited) {
      const latest = await Transaction.findOne({
        _id: transaction._id,
        user: req.user._id,
      });

      if (latest?.status === "completed") {
        const user = await User.findById(req.user._id).select(
          "walletBalance walletCurrency"
        );

        return res.json({
          success: true,
          message: "This payment has already been credited.",
          wallet: {
            balance: user?.walletBalance ?? 0,
            currency: user?.walletCurrency || "NGN",
          },
        });
      }

      return res.status(409).json({
        message: "Payment is still awaiting verification.",
      });
    }

    const user = await User.findById(req.user._id).select(
      "walletBalance walletCurrency"
    );

    return res.json({
      success: true,
      message: "Payment verified and wallet funded successfully.",
      wallet: {
        balance: user?.walletBalance ?? 0,
        currency: user?.walletCurrency || "NGN",
      },
      payment: {
        reference,
        amount: transaction.amount,
        currency: "NGN",
      },
    });
  } catch (error) {
    next(error);
  }
});


module.exports = router;
