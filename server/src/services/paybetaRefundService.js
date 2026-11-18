
const mongoose = require("mongoose");
const User = require("../models/user");
const Transaction = require("../models/transaction");

async function refundConfirmedFailure(transactionId, reference) {
  const session = await mongoose.startSession();

  try {
    let refunded = false;

    await session.withTransaction(async () => {
      const transaction = await Transaction.findOne({
        _id: transactionId,
        type: "data_purchase",
        reference,
        status: "pending",
      }).session(session);

      if (!transaction) {
        const existing = await Transaction.findOne({
          _id: transactionId,
          type: "data_purchase",
          reference,
        }).session(session);

        if (existing?.status === "failed") {
          refunded = Boolean(existing.metadata?.refunded);
          return;
        }

        throw new Error("Purchase transaction not found or not pending.");
      }

      const refundReference = `${reference}-refund`;

      const existingRefund = await Transaction.findOne({
        reference: refundReference,
      }).session(session);

      if (existingRefund) {
        const valid =
          existingRefund.type === "refund" &&
          existingRefund.status === "completed" &&
          String(existingRefund.user) === String(transaction.user) &&
          Number(existingRefund.amount) === Number(transaction.amount) &&
          existingRefund.metadata?.originalReference === reference;

        if (!valid) {
          throw new Error("Existing refund does not match the purchase.");
        }

        transaction.status = "failed";
        transaction.metadata = {
          ...(transaction.metadata || {}),
          refunded: true,
          refundReference,
        };

        await transaction.save({ session });
        refunded = true;
        return;
      }

      const walletUpdate = await User.updateOne(
        { _id: transaction.user },
        { $inc: { walletBalance: transaction.amount } },
        { session }
      );

      if (walletUpdate.matchedCount !== 1) {
        throw new Error("Customer wallet was not found.");
      }

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
        refundReference,
      };

      await transaction.save({ session });
      refunded = true;
    });

    return { refunded };
  } finally {
    await session.endSession();
  }
}

module.exports = { refundConfirmedFailure };
