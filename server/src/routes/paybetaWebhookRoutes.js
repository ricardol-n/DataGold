
const express = require("express");
const crypto = require("crypto");
const Transaction = require("../models/transaction");

const {
  refundConfirmedFailure,
} = require("../services/paybetaRefundService");

const router = express.Router();

const PAYBETA_BASE_URLS = {
  sandbox: "https://api.sandbox.paybeta.ng",
  production: "https://api.paybeta.ng",
};

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
    const apiKey = process.env.PAYBETA_API_KEY;
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

    const transaction = await Transaction.findOne({
      reference,
      type: "data_purchase",
    });

    if (!transaction) {
      return res.status(404).json({
        success: false,
        message: "DataGold transaction not found.",
      });
    }

    if (transaction.status !== "pending") {
      return res.status(200).json({
        success: true,
        message: "Transaction already processed.",
      });
    }

    const mode = process.env.PAYBETA_MODE;
    const baseUrl = (process.env.PAYBETA_BASE_URL || "").replace(/\/+$/, "");
    const expectedUrl = PAYBETA_BASE_URLS[mode];

    if (!expectedUrl || baseUrl !== expectedUrl) {
      return res.status(503).json({
        success: false,
        message: "Paybeta mode or base URL is incorrectly configured.",
      });
    }

    if (!apiKey) {
      return res.status(503).json({
        success: false,
        message: "Paybeta API key is not configured.",
      });
    }

    // Always verify the actual transaction status with Paybeta.
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

    if (!response.ok) {
      return res.status(503).json({
        success: false,
        message: "Unable to verify transaction status with Paybeta.",
      });
    }

    const result = await response.json();

    // Only refund when Paybeta confirms a final failure.
    if (String(result?.code) === "02") {
      const refundResult = await refundConfirmedFailure(
        transaction._id,
        reference
      );

      if (!refundResult.refunded) {
        return res.status(503).json({
          success: false,
          message: "Confirmed failure could not be reconciled yet.",
        });
      }

      return res.status(200).json({
        success: true,
        message: "Confirmed failed purchase refunded successfully.",
      });
    }

    const paymentStatus = String(
      result?.data?.paymentStatus || ""
    ).toLowerCase();

    // Complete only after Paybeta confirms delivery.
          if (
        String(result?.code) === "00" &&
        result?.status === "successful" &&
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

    // Pending, not found, and unknown results are not failures.
    // Never refund these automatically.
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
