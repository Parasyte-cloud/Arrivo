// Driver daily subscription, dashboard numbers and inspection status.
//
//   GET  /api/driver-subscription/dashboard  profile, today's trips and earnings,
//                                            subscription and inspection status
//   POST /api/driver-subscription/verify     { reference } after the Paystack popup
//
// Payment follows the wallet top-up pattern: the popup makes its own reference,
// the server asks Paystack what was actually paid and trusts only that.
const express = require("express");
const axios = require("axios");
const { pool } = require("../db/db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { claimPaymentReference, isValidPaystackReference } = require("../services/paymentReferences");
const { DAILY_PRICE_NAIRA, subscriptionStatus, inspectionStatus } = require("../services/driverSubscription");
const { isEnforced, TODAY_SQL } = require("../services/driverSubscriptionDb");

const router = express.Router();
const PAYSTACK_BASE = "https://api.paystack.co";

async function driverFor(userId) {
  const r = await pool.query(
    `SELECT d.id, d.is_verified, d.is_online, d.rating, d.profile_photo_url,
            to_char(d.last_inspection_on, 'YYYY-MM-DD') AS last_inspection_on,
            u.name, v.make_model, v.plate_number, v.vehicle_type
     FROM drivers d
     JOIN users u ON u.id = d.user_id
     LEFT JOIN vehicles v ON v.id = d.vehicle_id
     WHERE d.user_id = $1`,
    [userId]
  );
  return r.rows[0] || null;
}

async function paidDays(driverId) {
  const r = await pool.query(
    `SELECT to_char(day, 'YYYY-MM-DD') AS day FROM driver_subscription_days
     WHERE driver_id = $1 AND day >= ${TODAY_SQL} - 1`,
    [driverId]
  );
  return r.rows.map((x) => x.day);
}

router.get("/dashboard", requireAuth, requireRole("driver"), async (req, res) => {
  const driver = await driverFor(req.user.id);
  if (!driver) return res.status(404).json({ error: "Complete your driver profile first" });

  // "Today" is the Lagos day, so a night driver's total resets at 12am.
  const today = (
    await pool.query(
      `SELECT COUNT(*) FILTER (WHERE NOT is_fleet_companion) AS trips,
              COALESCE(SUM(fare_naira + promo_discount_naira + tip_naira), 0) AS earnings
       FROM rides
       WHERE driver_id = $1 AND ride_status = 'completed'
         AND (COALESCE(completed_at, updated_at) AT TIME ZONE 'Africa/Lagos')::date = ${TODAY_SQL}`,
      [driver.id]
    )
  ).rows[0];

  const sub = subscriptionStatus(await paidDays(driver.id));
  res.json({
    profile: {
      name: driver.name,
      photoUrl: driver.profile_photo_url,
      rating: driver.rating,
      isVerified: driver.is_verified,
      isOnline: driver.is_online,
      vehicle: driver.plate_number
        ? { makeModel: driver.make_model, plateNumber: driver.plate_number, type: driver.vehicle_type }
        : null,
    },
    today: { trips: Number(today.trips), earningsNaira: Number(today.earnings) },
    subscription: { ...sub, enforced: isEnforced() },
    inspection: inspectionStatus(driver.last_inspection_on),
  });
});

router.post("/verify", requireAuth, requireRole("driver"), async (req, res) => {
  const driver = await driverFor(req.user.id);
  if (!driver) return res.status(404).json({ error: "Complete your driver profile first" });

  const { reference } = req.body || {};
  if (!reference) return res.status(400).json({ error: "reference is required" });
  if (!isValidPaystackReference(reference)) return res.status(400).json({ error: "Invalid payment reference." });

  let data;
  try {
    const response = await axios.get(`${PAYSTACK_BASE}/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
      timeout: 10000,
    });
    data = response.data.data;
  } catch (err) {
    console.error("Paystack verify failed:", err.response?.data || err.message);
    return res.status(502).json({ error: "Could not verify payment with Paystack." });
  }

  if (!data || data.currency !== "NGN") return res.status(400).json({ error: "Only payments in naira are accepted." });
  if (data.status !== "success") return res.status(400).json({ error: "Payment was not successful.", status: data.status });
  if (Math.round(Number(data.amount)) !== DAILY_PRICE_NAIRA * 100) {
    return res.status(400).json({ error: `The daily subscription is ₦${DAILY_PRICE_NAIRA.toLocaleString("en-NG")}.` });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Serialize this driver's payments so two taps cannot both pass the check.
    await client.query("SELECT id FROM drivers WHERE id = $1 FOR UPDATE", [driver.id]);

    const existing = await client.query(
      "SELECT driver_id FROM driver_subscription_days WHERE paystack_reference = $1",
      [reference]
    );
    if (existing.rows.length) {
      await client.query("ROLLBACK");
      // Someone else's payment cannot buy this driver a day.
      if (existing.rows[0].driver_id !== driver.id) {
        return res.status(400).json({ error: "This payment reference has already been used. Contact support." });
      }
      // The driver's own payment, sent again: same answer, no change.
      return res.json({ success: true, alreadyApplied: true, subscription: { ...subscriptionStatus(await paidDays(driver.id)), enforced: isEnforced() } });
    }

    const today = (await client.query(`SELECT to_char(${TODAY_SQL}, 'YYYY-MM-DD') AS d`)).rows[0].d;
    const already = await client.query("SELECT 1 FROM driver_subscription_days WHERE driver_id = $1 AND day = $2", [driver.id, today]);
    if (already.rows.length) {
      // Paid twice for the same day. The reference is not claimed, so support
      // can see the charge was never applied and refund it.
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "You are already subscribed for today. This payment was not applied; contact support with reference " + reference + " for a refund.", code: "ALREADY_SUBSCRIBED" });
    }

    const claimed = await claimPaymentReference(client, reference, "driver_subscription");
    if (!claimed) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "This payment reference has already been used for a different charge. Contact support." });
    }

    await client.query(
      `INSERT INTO driver_subscription_days (driver_id, day, amount_naira, paystack_reference) VALUES ($1, $2, $3, $4)`,
      [driver.id, today, DAILY_PRICE_NAIRA, reference]
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Driver subscription save failed:", err.message);
    return res.status(500).json({ error: "Could not activate your subscription. Contact support with this reference: " + reference });
  } finally {
    client.release();
  }

  res.json({ success: true, subscription: { ...subscriptionStatus(await paidDays(driver.id)), enforced: isEnforced() } });
});

module.exports = router;
