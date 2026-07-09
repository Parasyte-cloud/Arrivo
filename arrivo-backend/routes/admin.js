const express = require("express");
const { pool } = require("../db/db");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();

router.use(requireAuth, requireRole("admin"));

// ── Drivers ──────────────────────────────────────────────────────────────

router.get("/drivers", async (req, res) => {
  const result = await pool.query(
    `SELECT drivers.id, drivers.is_verified, drivers.is_online, drivers.rating,
            drivers.license_number, drivers.lasdri_number, drivers.spoken_languages, drivers.created_at,
            drivers.current_lat, drivers.current_lng, drivers.location_updated_at,
            users.id as user_id, users.name, users.email, users.phone,
            vehicles.make_model, vehicles.plate_number, vehicles.vehicle_type
     FROM drivers
     JOIN users ON users.id = drivers.user_id
     LEFT JOIN vehicles ON vehicles.id = drivers.vehicle_id
     ORDER BY drivers.is_verified ASC, drivers.created_at DESC`
  );
  res.json({ drivers: result.rows });
});

router.patch("/drivers/:id/verify", async (req, res) => {
  const existing = await pool.query("SELECT * FROM drivers WHERE id = $1", [req.params.id]);
  if (!existing.rows[0]) return res.status(404).json({ error: "Driver not found" });

  await pool.query("UPDATE drivers SET is_verified = $1 WHERE id = $2", [!!req.body.isVerified, req.params.id]);
  res.json({ id: Number(req.params.id), isVerified: !!req.body.isVerified });
});

// ── Rides ────────────────────────────────────────────────────────────────

router.get("/rides", async (req, res) => {
  const { status } = req.query;
  const baseQuery = `
    SELECT rides.*, riders.name as rider_name, riders.email as rider_email,
           driver_users.name as driver_name
    FROM rides
    JOIN users riders ON riders.id = rides.rider_id
    LEFT JOIN drivers ON drivers.id = rides.driver_id
    LEFT JOIN users driver_users ON driver_users.id = drivers.user_id
  `;
  const result = status
    ? await pool.query(baseQuery + ` WHERE rides.ride_status = $1 ORDER BY rides.created_at DESC LIMIT 100`, [status])
    : await pool.query(baseQuery + ` ORDER BY rides.created_at DESC LIMIT 100`);

  res.json({ rides: result.rows.map((r) => ({ ...r, stops: JSON.parse(r.stops || "[]") })) });
});

router.patch("/rides/:id", async (req, res) => {
  const { adminNotes, rideStatus } = req.body;
  const existing = await pool.query("SELECT * FROM rides WHERE id = $1", [req.params.id]);
  const ride = existing.rows[0];
  if (!ride) return res.status(404).json({ error: "Ride not found" });

  const allowedStatuses = ["requested", "accepted", "in_progress", "completed", "cancelled"];
  if (rideStatus && !allowedStatuses.includes(rideStatus)) {
    return res.status(400).json({ error: `rideStatus must be one of: ${allowedStatuses.join(", ")}` });
  }

  const updated = await pool.query(
    "UPDATE rides SET admin_notes = $1, ride_status = $2, updated_at = now() WHERE id = $3 RETURNING *",
    [adminNotes ?? ride.admin_notes, rideStatus || ride.ride_status, ride.id]
  );
  res.json({ ride: { ...updated.rows[0], stops: JSON.parse(updated.rows[0].stops || "[]") } });
});

// ── Panic alerts ─────────────────────────────────────────────────────────

// GET /api/admin/panics — every ride with an active (unresolved) panic alert
router.get("/panics", async (req, res) => {
  const result = await pool.query(
    `SELECT rides.*, riders.name as rider_name, riders.phone as rider_phone, riders.email as rider_email,
            driver_users.name as driver_name, driver_users.phone as driver_phone,
            drivers.current_lat, drivers.current_lng
     FROM rides
     JOIN users riders ON riders.id = rides.rider_id
     LEFT JOIN drivers ON drivers.id = rides.driver_id
     LEFT JOIN users driver_users ON driver_users.id = drivers.user_id
     WHERE rides.panic_triggered_at IS NOT NULL AND rides.panic_resolved_at IS NULL
     ORDER BY rides.panic_triggered_at ASC`
  );
  res.json({ panics: result.rows.map((r) => ({ ...r, stops: JSON.parse(r.stops || "[]") })) });
});

// PATCH /api/admin/panics/:rideId/resolve — mark a panic alert as handled
router.patch("/panics/:rideId/resolve", async (req, res) => {
  const { notes } = req.body;
  const existing = await pool.query("SELECT * FROM rides WHERE id = $1", [req.params.rideId]);
  if (!existing.rows[0]) return res.status(404).json({ error: "Ride not found" });

  const updated = await pool.query(
    "UPDATE rides SET panic_resolved_at = now(), panic_notes = $1, updated_at = now() WHERE id = $2 RETURNING *",
    [notes || existing.rows[0].panic_notes, req.params.rideId]
  );
  res.json({ ride: { ...updated.rows[0], stops: JSON.parse(updated.rows[0].stops || "[]") } });
});

// ── Analytics ────────────────────────────────────────────────────────────

router.get("/analytics", async (req, res) => {
  const riderCount = Number((await pool.query("SELECT COUNT(*) as n FROM users WHERE role = 'rider'")).rows[0].n);
  const driverCount = Number((await pool.query("SELECT COUNT(*) as n FROM users WHERE role = 'driver'")).rows[0].n);
  const verifiedDriverCount = Number((await pool.query("SELECT COUNT(*) as n FROM drivers WHERE is_verified = true")).rows[0].n);
  const onlineDriverCount = Number((await pool.query("SELECT COUNT(*) as n FROM drivers WHERE is_online = true")).rows[0].n);
  const activePanicCount = Number(
    (await pool.query("SELECT COUNT(*) as n FROM rides WHERE panic_triggered_at IS NOT NULL AND panic_resolved_at IS NULL")).rows[0].n
  );

  const ridesByStatusResult = await pool.query("SELECT ride_status, COUNT(*) as n FROM rides GROUP BY ride_status");
  const ridesByStatus = ridesByStatusResult.rows.reduce((acc, row) => ({ ...acc, [row.ride_status]: Number(row.n) }), {});

  const revenue = Number(
    (await pool.query("SELECT COALESCE(SUM(fare_naira), 0) as total FROM rides WHERE payment_status = 'paid'")).rows[0].total
  );
  const revenueThisMonth = Number(
    (
      await pool.query(
        `SELECT COALESCE(SUM(fare_naira), 0) as total FROM rides
         WHERE payment_status = 'paid' AND date_trunc('month', created_at) = date_trunc('month', now())`
      )
    ).rows[0].total
  );

  res.json({
    riders: riderCount,
    drivers: driverCount,
    verifiedDrivers: verifiedDriverCount,
    onlineDrivers: onlineDriverCount,
    activePanics: activePanicCount,
    ridesByStatus,
    totalRevenueNaira: revenue,
    revenueThisMonthNaira: revenueThisMonth,
  });
});

module.exports = router;
