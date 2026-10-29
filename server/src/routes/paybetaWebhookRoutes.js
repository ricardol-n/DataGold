
const express = require("express");
const crypto = require("crypto");
const Transaction = require("../models/transaction");

const router = express.Router();

function verifyPaybetaSignature(reference, signature, secret) {
  if (
    typeof reference !== "string" ||
    typeof signature !== "string" ||
    !secret
  ) {
    return false;
  }

  const expected = crypto
    .createHmac("sha256", secret)
    .update(reference)
    .digest("hex");

  const received = signature.trim().replace(/^sha256=/i, "");

  if (!/^[a-f0-9]{64}$/i.test(received)) {
    return false;
  }

  const expectedBuffer = Buffer.from(expected, "hex");
  const receivedBuffer = Buffer.from(received, "hex");

  return (
    expectedBuffer.length === receivedBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, receivedBuffer)
  );
}

router.post("/", async (req, res) => {
  try {
    const secret = process.env.PAYBETA_SECRET_KEY;

    const reference = req.body?.data?.reference;
    const signature = req.get("Signature");

    if (!secret || !reference || !signature) {
      return res.status(400).json({
        success: false,
        message: "Missing webhook verification details.",
      });
    }

    if (!verifyPaybetaSignature(reference, signature, secret)) {
      return res.status(401).json({
        success: false,
        message: "Invalid Paybeta signature.",
      });
    }

    // Only reconcile DataGold data-purchase orders.
    const transaction = await Transaction.findOne({
      reference,
      type: "data_purchase",
    });

    if (!transaction) {
      // Do not acknowledge an unknown reference as processed.
      return res.status(404).json({
        success: false,
        message: "DataGold transaction not found.",
      });
    }

    // Never change a final transaction back to pending.
    if (transaction.status !== "pending") {
      return res.status(200).json({
        success: true,
        message: "Transaction already processed.",
      });
    }

    const baseUrl = process.env.PAYBETA_BASE_URL;
    const expectedUrl = "https://api.paybeta.ng";

    if (baseUrl !== expectedUrl) {
      return res.status(503).json({
        success: false,
        message: "Production Paybeta URL is not configured.",
      });
    }

    // Ask Paybeta for the transaction's current state.
    const response = await fetch(
      `${expectedUrl}/v2/transaction/query`,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "P-API-KEY": secret,
        },
        body: JSON.stringify({ reference }),
        signal: AbortSignal.timeout(10000),
      }
    );

    const result = await response.json();

    if (!response.ok || !result?.data) {
      return res.status(503).json({
        success: false,
        message: "Unable to verify transaction status with Paybeta.",
      });
    }

    const paymentStatus = String(
      result.data.paymentStatus || ""
    ).toLowerCase();

    // Only mark delivered when Paybeta confirms delivery.
    if (
      result.status === "successful" &&
      paymentStatus === "delivered"
    ) {
      const updated = await Transaction.findOneAndUpdate(
        {
          _id: transaction._id,
          status: "pending",
        },
        {
          $set: {
            status: "completed",
            "metadata.providerStatus": result.status,
            "metadata.paymentStatus": result.data.paymentStatus,
            "metadata.providerTransactionId":
              result.data.transactionId || null,
            "metadata.webhookReconciledAt": new Date(),
          },
        },
        { new: true }
      );

      return res.status(200).json({
        success: true,
        message: updated
          ? "Purchase delivery confirmed."
          : "Transaction was already processed.",
      });
    }

    // Unknown or unresolved states remain pending.
    // Do not refund or retry until a confirmed final failure
    // is handled by the dedicated reconciliation logic.
    return res.status(200).json({
      success: true,
      message: "Transaction received; status remains unresolved.",
    });
  } catch (error) {
    console.error("Paybeta webhook error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Webhook processing failed.",
    });
  }
});

module.exports = router;
