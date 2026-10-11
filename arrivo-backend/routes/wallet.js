const express = require("express");
const axios = require("axios");
const { pool } = require("../db/db");
const { requireAuth } = require("../middleware/auth");
const { isValidPaystackReference } = require("../services/paymentReferences");
const { creditWalletTopup } = require("../services/walletTopup");

const router = express.Router();
const PAYSTACK_BASE = "https://api.paystack.co";

function paystackHeaders() {
  return { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` };
}

// GET /api/wallet — current balance and recent transaction history.
router.get("/", requireAuth, async (req, res) => {
  const userResult = await pool.query("SELECT wallet_balance_naira FROM users WHERE id = $1", [req.user.id]);
  const txResult = await pool.query(
    "SELECT * FROM wallet_transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50",
    [req.user.id]
  );
  res.json({
    balanceNaira: Number(userResult.rows[0].wallet_balance_naira),
    transactions: txResult.rows,
  });
});

// POST /api/wallet/topup/verify
// body: { reference }
// Matches the same pattern the ride-payment flow already uses: the
// Paystack popup runs entirely client-side and generates its own
// reference, then this endpoint verifies that reference with Paystack
// directly and credits whatever Paystack confirms was actually paid —
// the client's own claimed amount is never trusted, only Paystack's.
router.post("/topup/verify", requireAuth, async (req, res) => {
  const { reference } = req.body;
  if (!reference) return res.status(400).json({ error: "reference is required" });
  // See isValidPaystackReference: this value goes into a URL called with the
  // secret key, so it must be a plain reference and nothing else.
  if (!isValidPaystackReference(reference)) return res.status(400).json({ error: "Invalid payment reference." });

  let paystackData;
  try {
    const response = await axios.get(`${PAYSTACK_BASE}/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: paystackHeaders(),
      timeout: 10000,
    });
    paystackData = response.data.data;
  } catch (err) {
    console.error("Paystack verify failed:", err.response?.data || err.message);
    return res.status(502).json({ error: "Could not verify payment with Paystack." });
  }

  if (paystackData.currency !== "NGN") {
    return res.status(400).json({ error: "Only payments in naira can be credited to the wallet." });
  }
  if (paystackData.status !== "success") {
    return res.status(400).json({ error: "Payment was not successful.", status: paystackData.status });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // The shared crediting code (services/walletTopup.js) is also what the
    // Paystack webhook uses, so whichever of the two arrives second finds the
    // reference already credited and does nothing. The UNIQUE constraint on
    // paystack_reference is the real safety net underneath.
    const credit = await creditWalletTopup(client, {
      userId: req.user.id,
      reference,
      amountNaira: paystackData.amount / 100,
    });
    if (!credit.credited && credit.reason === "already_credited") {
      await client.query("ROLLBACK");
      return res.json({ success: true, balanceNaira: credit.balanceNaira, alreadyCredited: true });
    }
    if (!credit.credited) {
      // Spent on a ride payment, tip or overage charge already -- see
      // services/paymentReferences.js.
      await client.query("ROLLBACK");
      console.error(`Reused payment reference on wallet top-up: ${reference} was already used for a different charge.`);
      return res.status(400).json({ error: "This payment reference has already been used for a different charge. Contact support." });
    }
    const newBalance = credit.balanceNaira;

    await client.query("COMMIT");
    res.json({ success: true, balanceNaira: newBalance });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Wallet top-up crediting failed:", err.message);
    res.status(500).json({ error: "Could not credit your wallet. Please contact support with this reference: " + reference });
  } finally {
    client.release();
  }
});

module.exports = router;
