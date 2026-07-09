const express = require("express");
const { pool } = require("../db/db");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();

async function getDriverForUser(userId) {
  const result = await pool.query("SELECT * FROM drivers WHERE user_id = $1", [userId]);
  return result.rows[0];
}

async function getDriverWithVehicle(userId) {
  const result = await pool.query(
    `SELECT drivers.*, users.name, users.email, users.phone,
            vehicles.make_model, vehicles.plate_number, vehicles.vehicle_type, vehicles.seats
     FROM drivers
     JOIN users ON users.id = drivers.user_id
     LEFT JOIN vehicles ON vehicles.id = drivers.vehicle_id
     WHERE drivers.user_id = $1`,
    [userId]
  );
  return result.rows[0];
}

// POST /api/drivers/profile — create or update the driver + vehicle profile
router.post("/profile", requireAuth, requireRole("driver"), async (req, res) => {
  const { licenseNumber, lasdriNumber, spokenLanguages = "en", vehicle } = req.body;

  let vehicleId = null;
  const existingDriver = await getDriverForUser(req.user.id);

  if (vehicle?.makeModel && vehicle?.plateNumber) {
    if (existingDriver?.vehicle_id) {
      await pool.query(
        `UPDATE vehicles SET make_model = $1, plate_number = $2, vehicle_type = $3, seats = $4 WHERE id = $5`,
        [vehicle.makeModel, vehicle.plateNumber, vehicle.vehicleType || "sedan", vehicle.seats || 4, existingDriver.vehicle_id]
      );
      vehicleId = existingDriver.vehicle_id;
    } else {
      const inserted = await pool.query(
        `INSERT INTO vehicles (owner_user_id, make_model, plate_number, vehicle_type, seats)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [req.user.id, vehicle.makeModel, vehicle.plateNumber, vehicle.vehicleType || "sedan", vehicle.seats || 4]
      );
      vehicleId = inserted.rows[0].id;
    }
  }

  if (existingDriver) {
    await pool.query(
      `UPDATE drivers SET license_number = $1, lasdri_number = $2, spoken_languages = $3, vehicle_id = COALESCE($4, vehicle_id)
       WHERE user_id = $5`,
      [licenseNumber || existingDriver.license_number, lasdriNumber || existingDriver.lasdri_number, spokenLanguages, vehicleId, req.user.id]
    );
  } else {
    await pool.query(
      `INSERT INTO drivers (user_id, vehicle_id, license_number, lasdri_number, spoken_languages)
       VALUES ($1, $2, $3, $4, $5)`,
      [req.user.id, vehicleId, licenseNumber || null, lasdriNumber || null, spokenLanguages]
    );
  }

  res.status(201).json({ driver: await getDriverWithVehicle(req.user.id) });
});

// GET /api/drivers/me
router.get("/me", requireAuth, requireRole("driver"), async (req, res) => {
  const driver = await getDriverWithVehicle(req.user.id);
  if (!driver) return res.status(404).json({ error: "No driver profile yet — complete it via POST /api/drivers/profile" });
  res.json({ driver });
});

// PATCH /api/drivers/status — toggle online/offline. Blocked unless verified.
router.patch("/status", requireAuth, requireRole("driver"), async (req, res) => {
  const driver = await getDriverForUser(req.user.id);
  if (!driver) return res.status(404).json({ error: "Complete your driver profile first" });

  if (req.body.isOnline && !driver.is_verified) {
    return res.status(403).json({ error: "Your account isn't verified yet. An admin needs to approve your driver profile before you can go online." });
  }

  await pool.query("UPDATE drivers SET is_online = $1 WHERE id = $2", [!!req.body.isOnline, driver.id]);
  res.json({ isOnline: !!req.body.isOnline });
});

// PATCH /api/drivers/location — the driver's phone posts its GPS coordinates
// here periodically while online. This is what lets a rider's tracking
// screen and the admin dashboard show a real live position instead of a
// stylized placeholder.
router.patch("/location", requireAuth, requireRole("driver"), async (req, res) => {
  const { lat, lng } = req.body;
  if (typeof lat !== "number" || typeof lng !== "number") {
    return res.status(400).json({ error: "lat and lng must both be numbers" });
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return res.status(400).json({ error: "lat/lng out of valid range" });
  }

  const driver = await getDriverForUser(req.user.id);
  if (!driver) return res.status(404).json({ error: "Complete your driver profile first" });

  await pool.query(
    "UPDATE drivers SET current_lat = $1, current_lng = $2, location_updated_at = now() WHERE id = $3",
    [lat, lng, driver.id]
  );
  res.json({ ok: true });
});

// GET /api/drivers/earnings
router.get("/earnings", requireAuth, requireRole("driver"), async (req, res) => {
  const driver = await getDriverForUser(req.user.id);
  if (!driver) return res.status(404).json({ error: "Complete your driver profile first" });

  const summary = (
    await pool.query(
      `SELECT COUNT(*) as "completedTrips", COALESCE(SUM(fare_naira), 0) as "totalNaira"
       FROM rides WHERE driver_id = $1 AND ride_status = 'completed'`,
      [driver.id]
    )
  ).rows[0];

  const thisMonth = (
    await pool.query(
      `SELECT COALESCE(SUM(fare_naira), 0) as "totalNaira"
       FROM rides WHERE driver_id = $1 AND ride_status = 'completed'
       AND date_trunc('month', created_at) = date_trunc('month', now())`,
      [driver.id]
    )
  ).rows[0];

  res.json({
    completedTrips: Number(summary.completedTrips),
    totalNaira: Number(summary.totalNaira),
    thisMonthNaira: Number(thisMonth.totalNaira),
  });
});

module.exports = { router, getDriverForUser, getDriverWithVehicle };
