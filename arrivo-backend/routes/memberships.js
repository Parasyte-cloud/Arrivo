const express = require("express");
const { pool } = require("../db/db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

const INDIVIDUAL_ANNUAL_PRICE = 250000; // NGN — flat annual price, adjust as the real pricing is decided
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

// GET /api/memberships/mine — the signed-in user's own active membership,
// and (if they're a company account) how many delegates are linked to them.
router.get("/mine", requireAuth, async (req, res) => {
  const membership = await pool.query(
    `SELECT * FROM memberships WHERE user_id = $1 AND status = 'active' AND expires_at > now() ORDER BY expires_at DESC LIMIT 1`,
    [req.user.id]
  );
  const delegateCount = await pool.query(
    `SELECT COUNT(*) FROM memberships WHERE company_account_id = $1 AND status = 'active'`,
    [req.user.id]
  );
  res.json({
    membership: membership.rows[0] || null,
    delegateCount: Number(delegateCount.rows[0].count),
  });
});

// POST /api/memberships/individual/subscribe
// Paid entirely from the wallet — per the requirement that membership
// billing connects to the same wallet a rider tops up for per-trip
// payment. If there's no balance, the fix is to top up first, not a
// separate card-payment path bolted onto this one endpoint.
router.post("/individual/subscribe", requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const existing = await client.query(
      `SELECT * FROM memberships WHERE user_id = $1 AND plan_type = 'individual_annual' AND status = 'active' AND expires_at > now()`,
      [req.user.id]
    );
    if (existing.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "You already have an active individual membership.", membership: existing.rows[0] });
    }

    const userResult = await client.query("SELECT wallet_balance_naira FROM users WHERE id = $1 FOR UPDATE", [req.user.id]);
    const balance = Number(userResult.rows[0].wallet_balance_naira);
    if (balance < INDIVIDUAL_ANNUAL_PRICE) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Insufficient wallet balance for the annual plan.", balanceNaira: balance, priceNaira: INDIVIDUAL_ANNUAL_PRICE });
    }

    const newBalanceResult = await client.query(
      "UPDATE users SET wallet_balance_naira = wallet_balance_naira - $1 WHERE id = $2 RETURNING wallet_balance_naira",
      [INDIVIDUAL_ANNUAL_PRICE, req.user.id]
    );
    const newBalance = Number(newBalanceResult.rows[0].wallet_balance_naira);

    const expiresAt = new Date(Date.now() + ONE_YEAR_MS);
    const membershipResult = await client.query(
      `INSERT INTO memberships (user_id, plan_type, status, expires_at, price_naira)
       VALUES ($1, 'individual_annual', 'active', $2, $3) RETURNING *`,
      [req.user.id, expiresAt, INDIVIDUAL_ANNUAL_PRICE]
    );

    await client.query(
      `INSERT INTO wallet_transactions (user_id, type, status, amount_naira, balance_after_naira, description)
       VALUES ($1, 'membership_charge', 'completed', $2, $3, 'Individual annual membership')`,
      [req.user.id, -INDIVIDUAL_ANNUAL_PRICE, newBalance]
    );

    await client.query("COMMIT");
    res.status(201).json({ membership: membershipResult.rows[0], walletBalanceNaira: newBalance });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Membership subscribe failed:", err.message);
    res.status(500).json({ error: "Could not process the membership subscription. Please try again." });
  } finally {
    client.release();
  }
});

// POST /api/memberships/corporate/link-delegate
// body: { delegateEmail }
// The signed-in user is the company account; this links an existing
// rider's account under it so they ride without per-trip payment, billed
// to the company instead. The company must have an active corporate
// membership before adding delegates.
router.post("/corporate/link-delegate", requireAuth, async (req, res) => {
  const { delegateEmail } = req.body;
  if (!delegateEmail) return res.status(400).json({ error: "delegateEmail is required" });

  const companyMembership = await pool.query(
    `SELECT * FROM memberships WHERE user_id = $1 AND plan_type = 'corporate_delegate' AND status = 'active' AND expires_at > now()`,
    [req.user.id]
  );
  if (!companyMembership.rows[0]) {
    return res.status(400).json({ error: "This account doesn't have an active corporate membership yet." });
  }

  const delegateUser = await pool.query("SELECT id FROM users WHERE email = $1", [delegateEmail.toLowerCase()]);
  if (!delegateUser.rows[0]) {
    return res.status(404).json({ error: "No RideArrivo account found for that email. The delegate needs to sign up first." });
  }

  const inserted = await pool.query(
    `INSERT INTO memberships (user_id, plan_type, status, expires_at, price_naira, company_account_id)
     VALUES ($1, 'corporate_delegate', 'active', $2, 0, $3) RETURNING *`,
    [delegateUser.rows[0].id, companyMembership.rows[0].expires_at, req.user.id]
  );
  res.status(201).json({ delegateMembership: inserted.rows[0] });
});

module.exports = router;
