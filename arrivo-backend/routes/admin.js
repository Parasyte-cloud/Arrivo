const express = require("express");
const db = require("../db/db");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();

// Every route here requires a logged-in admin. Applied once for the whole router.
router.use(requireAuth, requireRole("admin"));

// ── Drivers ──────────────────────────────────────────────────────────────

// GET /api/admin/drivers — every driver, with vehicle + verification status
router.get("/drivers", (req, res) => {
  const drivers = db
    .prepare(
      `SELECT drivers.id, drivers.is_verified, drivers.is_online, drivers.rating,
              drivers.license_number, drivers.lasdri_number, drivers.spoken_languages, drivers.created_at,
              users.id as user_id, users.name, users.email, users.phone,
              vehicles.make_model, vehicles.plate_number, vehicles.vehicle_type
       FROM drivers
       JOIN users ON users.id = drivers.user_id
       LEFT JOIN vehicles ON vehicles.id = drivers.vehicle_id
       ORDER BY drivers.is_verified ASC, drivers.created_at DESC`
    )
    .all();
  res.json({ drivers });
});

// PATCH /api/admin/drivers/:id/verify — approve or revoke a driver's verification
// body: { isVerified: true|false }
router.patch("/drivers/:id/verify", (req, res) => {
  const driver = db.prepare("SELECT * FROM drivers WHERE id = ?").get(req.params.id);
  if (!driver) return res.status(404).json({ error: "Driver not found" });

  db.prepare("UPDATE drivers SET is_verified = ? WHERE id = ?").run(req.body.isVerified ? 1 : 0, driver.id);
  res.json({ id: driver.id, isVerified: !!req.body.isVerified });
});

// ── Rides ────────────────────────────────────────────────────────────────

// GET /api/admin/rides — recent rides across the whole platform, for ops oversight
// optional query: ?status=requested|accepted|in_progress|completed|cancelled
router.get("/rides", (req, res) => {
  const { status } = req.query;
  const rows = status
    ? db
        .prepare(
          `SELECT rides.*, riders.name as rider_name, riders.email as rider_email,
                  driver_users.name as driver_name
           FROM rides
           JOIN users riders ON riders.id = rides.rider_id
           LEFT JOIN drivers ON drivers.id = rides.driver_id
           LEFT JOIN users driver_users ON driver_users.id = drivers.user_id
           WHERE rides.ride_status = ?
           ORDER BY rides.created_at DESC LIMIT 100`
        )
        .all(status)
    : db
        .prepare(
          `SELECT rides.*, riders.name as rider_name, riders.email as rider_email,
                  driver_users.name as driver_name
           FROM rides
           JOIN users riders ON riders.id = rides.rider_id
           LEFT JOIN drivers ON drivers.id = rides.driver_id
           LEFT JOIN users driver_users ON driver_users.id = drivers.user_id
           ORDER BY rides.created_at DESC LIMIT 100`
        )
        .all();

  res.json({ rides: rows.map((r) => ({ ...r, stops: JSON.parse(r.stops || "[]") })) });
});

// PATCH /api/admin/rides/:id — dispute resolution: add a note and/or force a status change
// body: { adminNotes?, rideStatus? }
router.patch("/rides/:id", (req, res) => {
  const { adminNotes, rideStatus } = req.body;
  const ride = db.prepare("SELECT * FROM rides WHERE id = ?").get(req.params.id);
  if (!ride) return res.status(404).json({ error: "Ride not found" });

  const allowedStatuses = ["requested", "accepted", "in_progress", "completed", "cancelled"];
  if (rideStatus && !allowedStatuses.includes(rideStatus)) {
    return res.status(400).json({ error: `rideStatus must be one of: ${allowedStatuses.join(", ")}` });
  }

  db.prepare("UPDATE rides SET admin_notes = ?, ride_status = ?, updated_at = datetime('now') WHERE id = ?").run(
    adminNotes ?? ride.admin_notes,
    rideStatus || ride.ride_status,
    ride.id
  );

  const updated = db.prepare("SELECT * FROM rides WHERE id = ?").get(ride.id);
  res.json({ ride: { ...updated, stops: JSON.parse(updated.stops || "[]") } });
});

// ── Analytics ────────────────────────────────────────────────────────────

// GET /api/admin/analytics — headline platform numbers
router.get("/analytics", (req, res) => {
  const riderCount = db.prepare("SELECT COUNT(*) as n FROM users WHERE role = 'rider'").get().n;
  const driverCount = db.prepare("SELECT COUNT(*) as n FROM users WHERE role = 'driver'").get().n;
  const verifiedDriverCount = db.prepare("SELECT COUNT(*) as n FROM drivers WHERE is_verified = 1").get().n;
  const onlineDriverCount = db.prepare("SELECT COUNT(*) as n FROM drivers WHERE is_online = 1").get().n;

  const ridesByStatus = db
    .prepare("SELECT ride_status, COUNT(*) as n FROM rides GROUP BY ride_status")
    .all()
    .reduce((acc, row) => ({ ...acc, [row.ride_status]: row.n }), {});

  const revenue = db
    .prepare("SELECT COALESCE(SUM(fare_naira), 0) as total FROM rides WHERE payment_status = 'paid'")
    .get().total;

  const revenueThisMonth = db
    .prepare(
      `SELECT COALESCE(SUM(fare_naira), 0) as total FROM rides
       WHERE payment_status = 'paid' AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')`
    )
    .get().total;

  res.json({
    riders: riderCount,
    drivers: driverCount,
    verifiedDrivers: verifiedDriverCount,
    onlineDrivers: onlineDriverCount,
    ridesByStatus,
    totalRevenueNaira: revenue,
    revenueThisMonthNaira: revenueThisMonth,
  });
});

module.exports = router;
