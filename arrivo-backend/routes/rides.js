const express = require("express");
const db = require("../db/db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { getDriverForUser } = require("./drivers");

const router = express.Router();

// POST /api/rides — create a new ride booking (requires auth)
// body: { pickupAddress, stops?, flightNumber?, vehicleType, fareNaira, paymentReference? }
router.post("/", requireAuth, (req, res) => {
  const { pickupAddress, stops, flightNumber, vehicleType, fareNaira, paymentReference } = req.body;

  if (!pickupAddress || !fareNaira) {
    return res.status(400).json({ error: "pickupAddress and fareNaira are required" });
  }

  const result = db
    .prepare(
      `INSERT INTO rides (rider_id, pickup_address, stops, flight_number, vehicle_type, fare_naira, payment_reference)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      req.user.id,
      pickupAddress,
      JSON.stringify(stops || []),
      flightNumber || null,
      vehicleType || null,
      fareNaira,
      paymentReference || null
    );

  const ride = db.prepare("SELECT * FROM rides WHERE id = ?").get(result.lastInsertRowid);
  res.status(201).json({ ride: { ...ride, stops: JSON.parse(ride.stops || "[]") } });
});

// GET /api/rides/mine — the signed-in rider's ride history
router.get("/mine", requireAuth, (req, res) => {
  const rides = db
    .prepare("SELECT * FROM rides WHERE rider_id = ? ORDER BY created_at DESC")
    .all(req.user.id)
    .map((r) => ({ ...r, stops: JSON.parse(r.stops || "[]") }));

  res.json({ rides });
});

// PATCH /api/rides/:id/payment — mark a ride's payment status
// (call this right after your payment verify step succeeds)
router.patch("/:id/payment", requireAuth, (req, res) => {
  const { paymentStatus, paymentReference } = req.body;
  const ride = db.prepare("SELECT * FROM rides WHERE id = ? AND rider_id = ?").get(req.params.id, req.user.id);

  if (!ride) return res.status(404).json({ error: "Ride not found" });

  db.prepare("UPDATE rides SET payment_status = ?, payment_reference = ? WHERE id = ?").run(
    paymentStatus || ride.payment_status,
    paymentReference || ride.payment_reference,
    ride.id
  );

  const updated = db.prepare("SELECT * FROM rides WHERE id = ?").get(ride.id);
  res.json({ ride: { ...updated, stops: JSON.parse(updated.stops || "[]") } });
});

// GET /api/rides/available — unassigned ride requests, for drivers to pick up
router.get("/available", requireAuth, requireRole("driver"), (req, res) => {
  const rides = db
    .prepare(
      `SELECT rides.*, users.name as rider_name, users.phone as rider_phone
       FROM rides
       JOIN users ON users.id = rides.rider_id
       WHERE rides.ride_status = 'requested' AND rides.driver_id IS NULL
       ORDER BY rides.created_at ASC
       LIMIT 20`
    )
    .all()
    .map((r) => ({ ...r, stops: JSON.parse(r.stops || "[]") }));

  res.json({ rides });
});

// POST /api/rides/:id/accept — a driver claims an unassigned ride.
// Guards against two drivers accepting the same ride at once: the UPDATE
// only succeeds if the ride is still unassigned at the moment it runs.
router.post("/:id/accept", requireAuth, requireRole("driver"), (req, res) => {
  const driver = getDriverForUser(req.user.id);
  if (!driver) return res.status(404).json({ error: "Complete your driver profile first" });

  const result = db
    .prepare(
      `UPDATE rides SET driver_id = ?, ride_status = 'accepted', updated_at = datetime('now')
       WHERE id = ? AND ride_status = 'requested' AND driver_id IS NULL`
    )
    .run(driver.id, req.params.id);

  if (result.changes === 0) {
    return res.status(409).json({ error: "This ride was just accepted by another driver" });
  }

  const ride = db
    .prepare(
      `SELECT rides.*, users.name as rider_name, users.phone as rider_phone
       FROM rides JOIN users ON users.id = rides.rider_id WHERE rides.id = ?`
    )
    .get(req.params.id);

  res.json({ ride: { ...ride, stops: JSON.parse(ride.stops || "[]") } });
});

// PATCH /api/rides/:id/status — driver updates trip progress
// body: { status: 'in_progress' | 'completed' | 'cancelled' }
router.patch("/:id/status", requireAuth, requireRole("driver"), (req, res) => {
  const { status } = req.body;
  const allowed = ["in_progress", "completed", "cancelled"];
  if (!allowed.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${allowed.join(", ")}` });
  }

  const driver = getDriverForUser(req.user.id);
  const ride = db.prepare("SELECT * FROM rides WHERE id = ? AND driver_id = ?").get(req.params.id, driver?.id);
  if (!ride) return res.status(404).json({ error: "Ride not found or not assigned to you" });

  db.prepare("UPDATE rides SET ride_status = ?, updated_at = datetime('now') WHERE id = ?").run(status, ride.id);

  const updated = db.prepare("SELECT * FROM rides WHERE id = ?").get(ride.id);
  res.json({ ride: { ...updated, stops: JSON.parse(updated.stops || "[]") } });
});

// GET /api/rides/driver/mine — this driver's accepted/active/completed rides
router.get("/driver/mine", requireAuth, requireRole("driver"), (req, res) => {
  const driver = getDriverForUser(req.user.id);
  if (!driver) return res.status(404).json({ error: "Complete your driver profile first" });

  const rides = db
    .prepare(
      `SELECT rides.*, users.name as rider_name, users.phone as rider_phone
       FROM rides JOIN users ON users.id = rides.rider_id
       WHERE rides.driver_id = ? ORDER BY rides.created_at DESC`
    )
    .all(driver.id)
    .map((r) => ({ ...r, stops: JSON.parse(r.stops || "[]") }));

  res.json({ rides });
});

module.exports = router;
