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
//   'not_in_holding'    routing is enforced and the money did not go to the holding account

const { claimPaymentReference } = require("./paymentReferences");

// The Paystack subaccount whose settlement account is the wallet holding account. Unset = top-ups settle to the
// main account as before.
function walletTopupSubaccount() {
  const v = String(process.env.PAYSTACK_WALLET_SUBACCOUNT || "").trim();
  return /^ACCT_[A-Za-z0-9]+$/.test(v) ? v : null;
}

async function creditWalletTopup(client, { userId, reference, amountNaira }) {
  const existing = await client.query("SELECT user_id FROM wallet_transactions WHERE paystack_reference = $1", [reference]);
  if (existing.rows[0]) {
    const balance = await client.query("SELECT wallet_balance_naira FROM users WHERE id = $1", [userId]);
    return { credited: false, reason: "already_credited", balanceNaira: Number(balance.rows[0].wallet_balance_naira) };
  }

  // Where did this payment's money go? The order was written by the server when the payment started, so a rider
  // cannot claim "holding" for themselves. A payment started some other way (the website's own popup) is 'direct'.
  const order = await client.query("SELECT funds_route FROM payment_orders WHERE reference = $1", [reference]);
  const route = order.rows[0] && order.rows[0].funds_route === "holding" ? "holding" : "direct";
  // Once the app starts every top-up on the server, switch this on and a top-up that did not go to the holding
  // account is refused (and shows in payment exceptions) instead of quietly mixing customer money.
  if (walletTopupSubaccount() && process.env.WALLET_TOPUP_REQUIRE_HOLDING === "true" && route !== "holding") {
    const balance = await client.query("SELECT wallet_balance_naira FROM users WHERE id = $1", [userId]);
    return { credited: false, reason: "not_in_holding", balanceNaira: Number(balance.rows[0].wallet_balance_naira) };
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
    `INSERT INTO wallet_transactions (user_id, type, status, amount_naira, balance_after_naira, paystack_reference, description, funding_route)
     VALUES ($1, 'topup', 'completed', $2, $3, $4, 'Wallet top-up', $5)`,
    [userId, amountNaira, balanceNaira, reference, route]
  );
  return { credited: true, balanceNaira };
}

module.exports = { creditWalletTopup, walletTopupSubaccount };
