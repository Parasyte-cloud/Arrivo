const express = require("express");
const axios = require("axios");
const { pool } = require("../db/db");
const { requireAuth } = require("../middleware/auth");

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

  let paystackData;
  try {
    const response = await axios.get(`${PAYSTACK_BASE}/transaction/verify/${reference}`, { headers: paystackHeaders() });
    paystackData = response.data.data;
  } catch (err) {
    console.error("Paystack verify failed:", err.response?.data || err.message);
    return res.status(502).json({ error: "Could not verify payment with Paystack." });
  }

  if (paystackData.status !== "success") {
    return res.status(400).json({ error: "Payment was not successful.", status: paystackData.status });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // The UNIQUE constraint on paystack_reference is the real safety net;
    // this check just lets us respond cleanly instead of a raw DB error
    // if the same reference is verified twice (e.g. a page reload).
    const existing = await client.query("SELECT * FROM wallet_transactions WHERE paystack_reference = $1", [reference]);
    if (existing.rows[0]) {
      await client.query("ROLLBACK");
      const balance = await pool.query("SELECT wallet_balance_naira FROM users WHERE id = $1", [req.user.id]);
      return res.json({ success: true, balanceNaira: Number(balance.rows[0].wallet_balance_naira), alreadyCredited: true });
    }

    const paidAmountNaira = paystackData.amount / 100;
    const userResult = await client.query(
      "UPDATE users SET wallet_balance_naira = wallet_balance_naira + $1 WHERE id = $2 RETURNING wallet_balance_naira",
      [paidAmountNaira, req.user.id]
    );
    const newBalance = Number(userResult.rows[0].wallet_balance_naira);

    await client.query(
      `INSERT INTO wallet_transactions (user_id, type, status, amount_naira, balance_after_naira, paystack_reference, description)
       VALUES ($1, 'topup', 'completed', $2, $3, $4, 'Wallet top-up')`,
      [req.user.id, paidAmountNaira, newBalance, reference]
    );

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
