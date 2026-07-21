const express = require("express");
const { pool } = require("../db/db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

// Any signed-in user can list a vehicle — a rider today might be a vehicle
// owner too (matches the website: "Vehicle owners... list it for pickups").
// There's no separate "owner" account type enforced here, just ownership
// of specific vehicle rows via owner_user_id.

// POST /api/owners/vehicles — list a new vehicle
// body: { makeModel, plateNumber, vehicleType?, seats? }
router.post("/vehicles", requireAuth, async (req, res) => {
  const { makeModel, plateNumber, vehicleType = "sedan", seats = 4 } = req.body;
  if (!makeModel || !plateNumber) {
    return res.status(400).json({ error: "makeModel and plateNumber are required" });
  }
  if (!["sedan", "suv", "truck", "pickup"].includes(vehicleType)) {
    return res.status(400).json({ error: "vehicleType must be one of: sedan, suv, truck, pickup" });
  }

  const inserted = await pool.query(
    `INSERT INTO vehicles (owner_user_id, make_model, plate_number, vehicle_type, seats)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [req.user.id, makeModel, plateNumber, vehicleType, seats]
  );
  res.status(201).json({ vehicle: inserted.rows[0] });
});

// GET /api/owners/vehicles/mine — vehicles this user has listed
router.get("/vehicles/mine", requireAuth, async (req, res) => {
  const result = await pool.query(
    "SELECT * FROM vehicles WHERE owner_user_id = $1 ORDER BY created_at DESC",
    [req.user.id]
  );
  res.json({ vehicles: result.rows });
});

// PATCH /api/owners/vehicles/:id/availability
// body: { availabilityNote }
router.patch("/vehicles/:id/availability", requireAuth, async (req, res) => {
  const { availabilityNote } = req.body;
  const existing = await pool.query(
    "SELECT * FROM vehicles WHERE id = $1 AND owner_user_id = $2",
    [req.params.id, req.user.id]
  );
  if (!existing.rows[0]) return res.status(404).json({ error: "Vehicle not found" });

  const updated = await pool.query(
    "UPDATE vehicles SET availability_note = $1 WHERE id = $2 RETURNING *",
    [availabilityNote || null, req.params.id]
  );
  res.json({ vehicle: updated.rows[0] });
});

// GET /api/owners/dashboard — real trip/earnings stats across all of this
// owner's vehicles, computed from actual completed rides (never fabricated).
// There's no automated payout system wired up yet (no bank details are
// collected anywhere in this app), so this intentionally reports trip
// volume and fare totals only — not a "next payout" figure that doesn't
// correspond to anything real happening in the backend.
router.get("/dashboard", requireAuth, async (req, res) => {
  const vehicles = await pool.query(
    "SELECT * FROM vehicles WHERE owner_user_id = $1 ORDER BY created_at DESC",
    [req.user.id]
  );

  if (vehicles.rows.length === 0) {
    return res.json({ vehicles: [], tripsCompleted: 0, tripsThisMonth: 0, fareThisMonthNaira: 0 });
  }

  const stats = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE rides.ride_status = 'completed') AS trips_completed,
       COUNT(*) FILTER (WHERE rides.ride_status = 'completed' AND rides.created_at >= date_trunc('month', now())) AS trips_this_month,
       COALESCE(SUM(rides.fare_naira) FILTER (WHERE rides.ride_status = 'completed' AND rides.created_at >= date_trunc('month', now())), 0) AS fare_this_month_naira
     FROM rides
     JOIN drivers ON drivers.id = rides.driver_id
     JOIN vehicles ON vehicles.id = drivers.vehicle_id
     WHERE vehicles.owner_user_id = $1`,
    [req.user.id]
  );
  const row = stats.rows[0];

  res.json({
    vehicles: vehicles.rows,
    tripsCompleted: Number(row.trips_completed),
    tripsThisMonth: Number(row.trips_this_month),
    fareThisMonthNaira: Number(row.fare_this_month_naira),
  });
});

module.exports = router;
