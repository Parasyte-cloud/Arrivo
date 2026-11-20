const express = require("express");
const { pool } = require("../db/db");
const { requireAuth } = require("../middleware/auth");
const { isValidPhone, phoneErrorMessage } = require("../services/phone");
const { SERVICE_JOB_TIERS } = require("../services/driverTiers");
const { logSafetyEvent } = require("../services/safetyEvents");

const router = express.Router();

// POST /api/service-requests
// Any rider can order any service. The ride is saved with its service, so the
// drivers who hold that tier (and only them) see it in their queue at once.
// There is no fixed price list for these services, so the ride starts with
// quote_pending set: a driver can take it, Ops confirms the price with the rider,
// and the trip cannot start until that price is on it.
// body: { service, pickupAddress, destinationAddress, contactPhone, requestedPickupAt?, passengerCount?, details? }
// GET /api/services: the home-screen catalogue (see services/catalogue.js).
router.get("/catalogue", requireAuth, (req, res) => {
  const { buildCatalogue } = require("../services/catalogue");
  const { isArrivoNowEnabled } = require("./instantRides");
  res.json({ services: buildCatalogue({ expressEnabled: isArrivoNowEnabled() }) });
});

router.post("/", requireAuth, async (req, res) => {
  const b = req.body || {};
  const service = String(b.service || "").toLowerCase();
  if (!SERVICE_JOB_TIERS.includes(service)) {
    return res.status(400).json({ error: `service must be one of: ${SERVICE_JOB_TIERS.join(", ")}.` });
  }
  if (req.user.role !== "rider") return res.status(403).json({ error: "Only riders can order a service." });
  // Campus is for students aged 16 and over; the rider confirms it before ordering.
  if (service === "campus" && b.confirmAge16 !== true) {
    return res.status(400).json({ error: "ArrivoCampus is for students aged 16 or over. Please confirm to continue.", code: "CAMPUS_AGE_CONFIRM" });
  }
  const pickup = String(b.pickupAddress || "").trim();
  const destination = String(b.destinationAddress || "").trim();
  if (pickup.length < 3) return res.status(400).json({ error: "Add a pickup address." });
  if (destination.length < 3) return res.status(400).json({ error: "Add a destination." });
  if (!b.contactPhone || !isValidPhone(b.contactPhone)) return res.status(400).json({ error: phoneErrorMessage("Contact phone number") });
  let when = null;
  if (b.requestedPickupAt) {
    when = new Date(b.requestedPickupAt);
    if (isNaN(when.getTime()) || when.getTime() < Date.now()) return res.status(400).json({ error: "Pick a pickup time in the future." });
  }
  let passengers = null;
  if (b.passengerCount !== undefined && b.passengerCount !== null && b.passengerCount !== "") {
    passengers = Number(b.passengerCount);
    if (!Number.isInteger(passengers) || passengers < 1 || passengers > 50) return res.status(400).json({ error: "passengerCount must be a whole number from 1 to 50." });
  }
  // Two identical requests within a minute are a double tap, not two orders.
  const dup = await pool.query(
    `SELECT * FROM rides WHERE rider_id = $1 AND service = $2 AND pickup_address = $3 AND ride_status = 'requested'
       AND created_at > now() - interval '1 minute' LIMIT 1`, [req.user.id, service, pickup]);
  if (dup.rows[0]) return res.status(200).json({ ride: dup.rows[0], duplicate: true });

  const created = await pool.query(
    `INSERT INTO rides (rider_id, pickup_address, stops, booking_type, service, fare_naira, payment_status,
                        ride_status, agreed_cancellation_policy, quote_pending, scheduled_pickup_at, rider_note,
                        contact_phone, passenger_count)
     VALUES ($1, $2, $3, 'service_job', $4, 0, 'pending', 'requested', true, true, $5, $6, $7, $8) RETURNING *`,
    [req.user.id, pickup, JSON.stringify([destination]), service, when,
     b.details ? String(b.details).slice(0, 1000) : null, String(b.contactPhone).trim(), passengers]
  );
  const ride = created.rows[0];
  await logSafetyEvent(pool, "service_request_created", { rideId: ride.id, userId: req.user.id, detail: { service } });
  res.status(201).json({ ride: { ...ride, stops: JSON.parse(ride.stops || "[]") } });
});

module.exports = router;
