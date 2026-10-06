// Arrivo Family Plan -- "One account. Your whole family."
// A family admin funds one shared wallet; up to a plan-tier member cap
// (including the admin) can ride against it -- the admin can book for any
// member, and any active member can also book for themselves, so nobody is
// stranded waiting for the admin to be reachable (see the brief's own pull
// quote: "I don't want my family member stranded because they don't have
// transport money"). Booking itself happens through POST /api/rides with
// paymentMethod: 'family_wallet' (see routes/rides.js) -- this file only
// owns plan/member/wallet management and the family-scoped views.
const express = require("express");
const axios = require("axios");
const { pool } = require("../db/db");
const { requireAuth } = require("../middleware/auth");
const { getConfigNumber } = require("../services/systemConfig");
const { sendPushNotification } = require("../services/pushNotifications");
const { PLAN_LIMITS, getActivePlanForUser: getActivePlanForUserShared } = require("../services/familyPlan");
const { claimPaymentReference } = require("../services/paymentReferences");

const router = express.Router();
const PAYSTACK_BASE = "https://api.paystack.co";

function paystackHeaders() {
  return { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` };
}

async function getPlanPriceNaira(planType) {
  const key = { lite: "family_plan_lite_price_naira", plus: "family_plan_plus_price_naira", max: "family_plan_max_price_naira" }[planType];
  return getConfigNumber(key, 15000);
}

// Thin wrapper so the rest of this file doesn't need to know the shared
// helper takes `pool` explicitly (routes/rides.js, which has no router-
// local `pool` variable of its own to close over, needs that).
async function getActivePlanForUser(userId) {
  return getActivePlanForUserShared(pool, userId);
}

// GET /api/family/pricing -- current monthly price for each tier, so the
// app can show real numbers on the "choose a plan" screen without
// hard-coding them (they're explicitly "not yet finalised" per the
// brief, and system_config is the single source of truth).
router.get("/pricing", requireAuth, async (req, res) => {
  const [lite, plus, max] = await Promise.all([
    getPlanPriceNaira("lite"),
    getPlanPriceNaira("plus"),
    getPlanPriceNaira("max"),
  ]);
  res.json({
    tiers: [
      { planType: "lite", maxMembers: PLAN_LIMITS.lite, priceNaira: lite },
      { planType: "plus", maxMembers: PLAN_LIMITS.plus, priceNaira: plus },
      { planType: "max", maxMembers: PLAN_LIMITS.max, priceNaira: max },
    ],
  });
});

// GET /api/family/mine -- the caller's plan (as admin or member), its
// members, and wallet balance. Empty plan: null, not an error -- most
// riders simply aren't in one.
router.get("/mine", requireAuth, async (req, res) => {
  const plan = await getActivePlanForUser(req.user.id);
  if (!plan) return res.json({ plan: null, members: [] });

  const members = await pool.query(
    `SELECT fm.id, fm.user_id, fm.member_role, fm.status, fm.added_at, u.name, u.phone, u.email, u.avatar_url
       FROM family_members fm JOIN users u ON u.id = fm.user_id
      WHERE fm.family_plan_id = $1 AND fm.status = 'active'
      ORDER BY fm.member_role DESC, fm.added_at ASC`,
    [plan.id]
  );

  res.json({
    plan: {
      id: plan.id,
      planType: plan.plan_type,
      maxMembers: plan.max_members,
      priceNaira: Number(plan.price_naira),
      walletBalanceNaira: Number(plan.wallet_balance_naira),
      status: plan.status,
      startedAt: plan.started_at,
      renewsAt: plan.renews_at,
      myRole: plan.member_role,
    },
    members: members.rows,
  });
});

// POST /api/family/plans  body: { planType: 'lite' | 'plus' | 'max' }
// Creates a new plan with the caller as its admin. A user already in a
// plan (as admin or member) must leave/be removed first -- one family per
// person, matching the brief's "one account" framing.
router.post("/plans", requireAuth, async (req, res) => {
  const { planType } = req.body;
  if (!PLAN_LIMITS[planType]) {
    return res.status(400).json({ error: "planType must be 'lite', 'plus', or 'max'" });
  }

  const existing = await getActivePlanForUser(req.user.id);
  if (existing) {
    return res.status(400).json({ error: "You're already part of a family plan. Leave it before creating a new one." });
  }

  const priceNaira = await getPlanPriceNaira(planType);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const renewsAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const planResult = await client.query(
      `INSERT INTO family_plans (admin_user_id, plan_type, max_members, price_naira, renews_at)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [req.user.id, planType, PLAN_LIMITS[planType], priceNaira, renewsAt]
    );
    const plan = planResult.rows[0];
    await client.query(
      `INSERT INTO family_members (family_plan_id, user_id, member_role) VALUES ($1, $2, 'admin')`,
      [plan.id, req.user.id]
    );
    await client.query("COMMIT");
    res.status(201).json({
      plan: {
        id: plan.id, planType: plan.plan_type, maxMembers: plan.max_members,
        priceNaira: Number(plan.price_naira), walletBalanceNaira: 0, status: plan.status,
        startedAt: plan.started_at, renewsAt: plan.renews_at, myRole: "admin",
      },
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Family plan creation failed:", err.message);
    res.status(500).json({ error: "Could not create the family plan. Please try again." });
  } finally {
    client.release();
  }
});

// Shared guard: loads the plan and confirms the caller is its admin, or
// responds and returns null. Every member-management action below is
// admin-only, matching the brief's capability list exactly.
async function requireAdminOfPlan(req, res, planId) {
  const plan = await pool.query("SELECT * FROM family_plans WHERE id = $1 AND status = 'active'", [planId]);
  if (!plan.rows[0]) {
    res.status(404).json({ error: "Family plan not found." });
    return null;
  }
  if (plan.rows[0].admin_user_id !== req.user.id) {
    res.status(403).json({ error: "Only the family administrator can do this." });
    return null;
  }
  return plan.rows[0];
}

// POST /api/family/plans/:id/members  body: { phone } or { email }
// Adds an existing Arrivo user (looked up by phone or email -- there's no
// separate invitation flow yet, so the person must already have an
// account) as a member.
router.post("/plans/:id/members", requireAuth, async (req, res) => {
  const plan = await requireAdminOfPlan(req, res, req.params.id);
  if (!plan) return;

  const { phone, email } = req.body;
  if (!phone && !email) return res.status(400).json({ error: "phone or email is required" });

  const userResult = await pool.query(
    phone ? "SELECT * FROM users WHERE phone = $1" : "SELECT * FROM users WHERE LOWER(email) = LOWER($1)",
    [phone || email]
  );
  const targetUser = userResult.rows[0];
  if (!targetUser) {
    return res.status(404).json({ error: "No RideArrivo account found with that " + (phone ? "phone number" : "email") + "." });
  }

  const countResult = await pool.query(
    "SELECT COUNT(*) FROM family_members WHERE family_plan_id = $1 AND status = 'active'",
    [plan.id]
  );
  if (Number(countResult.rows[0].count) >= plan.max_members) {
    return res.status(400).json({ error: `This plan is full (${plan.max_members} members). Upgrade the plan to add more.` });
  }

  const alreadyInAPlan = await getActivePlanForUser(targetUser.id);
  if (alreadyInAPlan) {
    return res.status(400).json({ error: `${targetUser.name} is already part of a family plan.` });
  }

  const inserted = await pool.query(
    `INSERT INTO family_members (family_plan_id, user_id, member_role) VALUES ($1, $2, 'member') RETURNING *`,
    [plan.id, targetUser.id]
  );

  sendPushNotification(
    targetUser.push_token,
    "You've been added to a Family Plan",
    "You can now book rides from the shared family wallet.",
    { type: "family_plan_added" }
  ).catch(() => {});

  res.status(201).json({
    member: { id: inserted.rows[0].id, userId: targetUser.id, name: targetUser.name, phone: targetUser.phone, email: targetUser.email, memberRole: "member", status: "active" },
  });
});

// DELETE /api/family/plans/:id/members/:memberId
router.delete("/plans/:id/members/:memberId", requireAuth, async (req, res) => {
  const plan = await requireAdminOfPlan(req, res, req.params.id);
  if (!plan) return;

  const member = await pool.query(
    "SELECT * FROM family_members WHERE id = $1 AND family_plan_id = $2 AND status = 'active'",
    [req.params.memberId, plan.id]
  );
  if (!member.rows[0]) return res.status(404).json({ error: "Member not found." });
  if (member.rows[0].member_role === "admin") {
    return res.status(400).json({ error: "The family administrator can't be removed. Cancel the plan instead." });
  }

  await pool.query(
    "UPDATE family_members SET status = 'removed', removed_at = now() WHERE id = $1",
    [member.rows[0].id]
  );
  res.json({ removed: true });
});

// POST /api/family/plans/:id/wallet/topup/verify  body: { reference }
// Same Paystack-verify-then-credit pattern as routes/wallet.js's personal
// top-up -- the client's claimed amount is never trusted, only what
// Paystack confirms. Admin-only, per the brief's capability list
// ("Fund the family wallet" is listed under the Family Administrator).
router.post("/plans/:id/wallet/topup/verify", requireAuth, async (req, res) => {
  const plan = await requireAdminOfPlan(req, res, req.params.id);
  if (!plan) return;

  const { reference } = req.body;
  if (!reference) return res.status(400).json({ error: "reference is required" });

  let paystackData;
  try {
    const response = await axios.get(`${PAYSTACK_BASE}/transaction/verify/${reference}`, { headers: paystackHeaders() });
    paystackData = response.data.data;
  } catch (err) {
    console.error("Paystack verify failed (family wallet top-up):", err.response?.data || err.message);
    return res.status(502).json({ error: "Could not verify payment with Paystack." });
  }
  if (paystackData.status !== "success") {
    return res.status(400).json({ error: "Payment was not successful.", status: paystackData.status });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const existingTx = await client.query("SELECT * FROM family_wallet_transactions WHERE paystack_reference = $1", [reference]);
    if (existingTx.rows[0]) {
      await client.query("ROLLBACK");
      const fresh = await pool.query("SELECT wallet_balance_naira FROM family_plans WHERE id = $1", [plan.id]);
      return res.json({ success: true, walletBalanceNaira: Number(fresh.rows[0].wallet_balance_naira), alreadyCredited: true });
    }

    // Beyond the same-topup replay check above, this reference must not
    // already have been spent on a ride payment/tip/overage charge/personal
    // wallet top-up either -- see services/paymentReferences.js.
    const claimed = await claimPaymentReference(client, reference, "family_wallet_topup");
    if (!claimed) {
      await client.query("ROLLBACK");
      console.error(`Reused payment reference on family wallet top-up: ${reference} was already used to pay for a different charge.`);
      return res.status(400).json({ error: "This payment reference has already been used for a different charge. Contact support." });
    }

    const paidAmountNaira = paystackData.amount / 100;
    const updated = await client.query(
      "UPDATE family_plans SET wallet_balance_naira = wallet_balance_naira + $1 WHERE id = $2 RETURNING wallet_balance_naira",
      [paidAmountNaira, plan.id]
    );
    const newBalance = Number(updated.rows[0].wallet_balance_naira);

    await client.query(
      `INSERT INTO family_wallet_transactions (family_plan_id, actor_user_id, type, status, amount_naira, balance_after_naira, paystack_reference, description)
       VALUES ($1, $2, 'topup', 'completed', $3, $4, $5, 'Family wallet top-up')`,
      [plan.id, req.user.id, paidAmountNaira, newBalance, reference]
    );

    await client.query("COMMIT");
    res.json({ success: true, walletBalanceNaira: newBalance });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Family wallet top-up crediting failed:", err.message);
    res.status(500).json({ error: "Could not credit the family wallet. Please contact support with this reference: " + reference });
  } finally {
    client.release();
  }
});

// GET /api/family/plans/:id/rides -- every member's active + past rides
// paid from this family wallet, for the admin's "see active rides & track
// journeys live" / "view trip history" capabilities. Any active member can
// also call this for their own visibility into shared spend, but only
// rows for members of THIS plan are ever returned.
router.get("/plans/:id/rides", requireAuth, async (req, res) => {
  const membership = await pool.query(
    "SELECT * FROM family_members WHERE family_plan_id = $1 AND user_id = $2 AND status = 'active'",
    [req.params.id, req.user.id]
  );
  if (!membership.rows[0]) return res.status(403).json({ error: "You're not a member of this family plan." });

  const rides = await pool.query(
    `SELECT rides.*, u.name AS rider_name
       FROM rides JOIN users u ON u.id = rides.rider_id
      WHERE rides.booked_via_family_plan_id = $1
      ORDER BY rides.created_at DESC LIMIT 100`,
    [req.params.id]
  );
  res.json({ rides: rides.rows.map((r) => ({ ...r, stops: JSON.parse(r.stops || "[]") })) });
});

module.exports = router;
