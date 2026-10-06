const express = require("express");
const { pool } = require("../db/db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

// Premium / Executive — monthly membership tiers, corrected 2026-09 from
// the original annual, single-tier ("individual_annual" / "corporate_delegate")
// model. Still paid entirely from the wallet at subscribe time, same as
// the old model — top up first if there's not enough balance, there's no
// separate card-payment path bolted onto this endpoint.
//
// cashbackPercent is credited to the rider's own wallet on EVERY completed,
// paid trip a member (or one of their linked profile users) takes — see
// services/membershipCashback.js — including a trip paid via the
// 'membership' payment method itself (routes/rides.js), where the member
// doesn't pay the fare but still earns cashback on it as a loyalty bonus on
// top of the free ride.
//
// maxProfileUsers is the total seat count on the plan, the subscribing
// member included — Premium is a single seat; Executive is up to 3 (the
// member plus up to 2 linked profile users, see POST /profile-users/add).
const PLANS = {
  premium: {
    key: "premium",
    label: "Premium",
    priceNaira: 250000,
    cashbackPercent: 3,
    maxProfileUsers: 1,
    tripCoverage: "All trips within your location, including airport pickup/drop-off, and trips within Lagos.",
  },
  executive: {
    key: "executive",
    label: "Executive",
    priceNaira: 500000,
    cashbackPercent: 5,
    maxProfileUsers: 3,
    tripCoverage: "All trips within Lagos, inclusive of pickup and drop-offs.",
  },
};

// No recurring/auto-charge job exists yet — a monthly membership simply
// expires after 30 days and the member re-subscribes from the app or
// website, same manual pattern the old annual plan used. Building real
// recurring billing (retry-on-failure, dunning, etc.) is a separate piece
// of work, not part of this billing-cycle correction.
const ONE_MONTH_MS = 30 * 24 * 60 * 60 * 1000;

function getPlan(key) {
  return PLANS[String(key || "").trim().toLowerCase()] || null;
}

// GET /api/memberships/plans — public catalogue (no auth) so the app and
// website can render pricing/features from one source instead of each
// hardcoding its own copy of the numbers.
router.get("/plans", (req, res) => {
  res.json({ plans: Object.values(PLANS) });
});

// GET /api/memberships/mine — the signed-in user's own active membership,
// and (if they're an Executive member) which profile users are linked
// under it.
router.get("/mine", requireAuth, async (req, res) => {
  const membership = await pool.query(
    `SELECT * FROM memberships WHERE user_id = $1 AND status = 'active' AND expires_at > now() ORDER BY expires_at DESC LIMIT 1`,
    [req.user.id]
  );
  const profileUsers = await pool.query(
    `SELECT memberships.id, memberships.user_id, users.name, users.email
     FROM memberships JOIN users ON users.id = memberships.user_id
     WHERE memberships.company_account_id = $1 AND memberships.status = 'active' AND memberships.expires_at > now()
     ORDER BY memberships.created_at ASC`,
    [req.user.id]
  );
  const row = membership.rows[0];
  res.json({
    membership: row
      ? { ...row, price_naira: Number(row.price_naira), cashback_percent: Number(row.cashback_percent), max_profile_users: Number(row.max_profile_users) }
      : null,
    profileUsers: profileUsers.rows,
  });
});

// POST /api/memberships/subscribe   body: { plan: 'premium' | 'executive' }
router.post("/subscribe", requireAuth, async (req, res) => {
  const plan = getPlan(req.body?.plan);
  if (!plan) return res.status(400).json({ error: "plan must be 'premium' or 'executive'." });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const existing = await client.query(
      `SELECT * FROM memberships WHERE user_id = $1 AND plan_type IN ('premium', 'executive') AND status = 'active' AND expires_at > now()`,
      [req.user.id]
    );
    if (existing.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "You already have an active membership.", membership: existing.rows[0] });
    }

    const userResult = await client.query("SELECT wallet_balance_naira FROM users WHERE id = $1 FOR UPDATE", [req.user.id]);
    const balance = Number(userResult.rows[0].wallet_balance_naira);
    if (balance < plan.priceNaira) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: `Insufficient wallet balance for the ${plan.label} plan.`,
        balanceNaira: balance,
        priceNaira: plan.priceNaira,
      });
    }

    const newBalanceResult = await client.query(
      "UPDATE users SET wallet_balance_naira = wallet_balance_naira - $1 WHERE id = $2 RETURNING wallet_balance_naira",
      [plan.priceNaira, req.user.id]
    );
    const newBalance = Number(newBalanceResult.rows[0].wallet_balance_naira);

    const expiresAt = new Date(Date.now() + ONE_MONTH_MS);
    const membershipResult = await client.query(
      `INSERT INTO memberships (user_id, plan_type, status, expires_at, price_naira, cashback_percent, max_profile_users)
       VALUES ($1, $2, 'active', $3, $4, $5, $6) RETURNING *`,
      [req.user.id, plan.key, expiresAt, plan.priceNaira, plan.cashbackPercent, plan.maxProfileUsers]
    );

    await client.query(
      `INSERT INTO wallet_transactions (user_id, type, status, amount_naira, balance_after_naira, description)
       VALUES ($1, 'membership_charge', 'completed', $2, $3, $4)`,
      [req.user.id, -plan.priceNaira, newBalance, `${plan.label} membership — monthly`]
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

// POST /api/memberships/profile-users/add   body: { profileUserEmail }
// Executive only — links an existing rider account as one of the plan's
// "up to 3 profile users" (the Executive member plus up to 2 more). A
// linked profile user shares the plan's trip coverage and cashback rate on
// their OWN rides, billed under this account's membership rather than
// paying for a separate subscription of their own.
router.post("/profile-users/add", requireAuth, async (req, res) => {
  const { profileUserEmail } = req.body;
  if (!profileUserEmail) return res.status(400).json({ error: "profileUserEmail is required" });

  const ownMembership = await pool.query(
    `SELECT * FROM memberships WHERE user_id = $1 AND plan_type = 'executive' AND status = 'active' AND expires_at > now()`,
    [req.user.id]
  );
  if (!ownMembership.rows[0]) {
    return res.status(400).json({ error: "Only an active Executive membership can add profile users." });
  }

  const maxProfileUsers = Number(ownMembership.rows[0].max_profile_users);
  const maxAdditional = maxProfileUsers - 1; // the Executive member themself takes one of the seats

  const currentCount = await pool.query(
    `SELECT COUNT(*) FROM memberships WHERE company_account_id = $1 AND status = 'active' AND expires_at > now()`,
    [req.user.id]
  );
  if (Number(currentCount.rows[0].count) >= maxAdditional) {
    return res.status(400).json({
      error: `The Executive plan supports up to ${maxProfileUsers} profile users in total (you plus ${maxAdditional}). Remove one before adding another.`,
    });
  }

  // Only a 'rider' account can be added as a profile user — a driver or
  // admin account being silently added (which grants free-ride coverage
  // and cashback billed under this membership) simply by knowing their
  // email is not something to allow.
  const profileUser = await pool.query("SELECT id, role FROM users WHERE email = $1", [profileUserEmail.toLowerCase()]);
  if (!profileUser.rows[0]) {
    return res.status(404).json({ error: "No RideArrivo account found for that email. They need to sign up first." });
  }
  if (profileUser.rows[0].role !== "rider") {
    return res.status(400).json({ error: "Only a rider account can be added as a profile user." });
  }

  // A rider already linked (to this Executive account or a different one)
  // shouldn't get a second active profile-user row — that could stack
  // multiple memberships covering the same rider's trips, or silently
  // re-link someone away from a plan that added them without either
  // member's knowledge.
  const alreadyLinked = await pool.query(
    `SELECT id FROM memberships WHERE user_id = $1 AND plan_type = 'executive_profile' AND company_account_id IS NOT NULL AND status = 'active' AND expires_at > now()`,
    [profileUser.rows[0].id]
  );
  if (alreadyLinked.rows[0]) {
    return res.status(400).json({ error: "This rider is already a profile user on an Executive membership." });
  }

  const inserted = await pool.query(
    `INSERT INTO memberships (user_id, plan_type, status, expires_at, price_naira, cashback_percent, max_profile_users, company_account_id)
     VALUES ($1, 'executive_profile', 'active', $2, 0, $3, $4, $5) RETURNING *`,
    [
      profileUser.rows[0].id,
      ownMembership.rows[0].expires_at,
      ownMembership.rows[0].cashback_percent,
      maxProfileUsers,
      req.user.id,
    ]
  );
  res.status(201).json({ profileUserMembership: inserted.rows[0] });
});

module.exports = router;
