// Credits a verified Paystack payment to a rider's wallet. Shared by
// POST /api/wallet/topup/verify (the app asks) and the Paystack webhook (the
// app never came back), so the two can never disagree about what crediting
// means, and whichever arrives second does nothing.
//
// The caller must already have confirmed with Paystack that the payment
// succeeded in naira, and passes the amount Paystack reports, never one the
// client claimed. Must be called inside an open transaction on `client`.
//
// Returns { credited: true, balanceNaira } the first time, or
// { credited: false, reason, balanceNaira } when it did nothing:
//   'already_credited'  this reference already topped up a wallet
//   'reference_spent'   it already paid for something else (ride, tip, ...)

const { claimPaymentReference } = require("./paymentReferences");

async function creditWalletTopup(client, { userId, reference, amountNaira }) {
  const existing = await client.query("SELECT user_id FROM wallet_transactions WHERE paystack_reference = $1", [reference]);
  if (existing.rows[0]) {
    const balance = await client.query("SELECT wallet_balance_naira FROM users WHERE id = $1", [userId]);
    return { credited: false, reason: "already_credited", balanceNaira: Number(balance.rows[0].wallet_balance_naira) };
  }

  const claimed = await claimPaymentReference(client, reference, "wallet_topup");
  if (!claimed) {
    const balance = await client.query("SELECT wallet_balance_naira FROM users WHERE id = $1", [userId]);
    return { credited: false, reason: "reference_spent", balanceNaira: Number(balance.rows[0].wallet_balance_naira) };
  }

  const updated = await client.query(
    "UPDATE users SET wallet_balance_naira = wallet_balance_naira + $1 WHERE id = $2 RETURNING wallet_balance_naira",
    [amountNaira, userId]
  );
  const balanceNaira = Number(updated.rows[0].wallet_balance_naira);
  await client.query(
    `INSERT INTO wallet_transactions (user_id, type, status, amount_naira, balance_after_naira, paystack_reference, description)
     VALUES ($1, 'topup', 'completed', $2, $3, $4, 'Wallet top-up')`,
    [userId, amountNaira, balanceNaira, reference]
  );
  return { credited: true, balanceNaira };
}

module.exports = { creditWalletTopup };
