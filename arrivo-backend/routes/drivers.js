const express = require("express");
const db = require("../db/db");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();

// Shared helper — other route files (rides.js) import this too, so a
// driver's numeric `drivers.id` never has to be looked up more than once per request.
function getDriverForUser(userId) {
  return db.prepare("SELECT * FROM drivers WHERE user_id = ?").get(userId);
}

function getDriverWithVehicle(userId) {
  return db
    .prepare(
      `SELECT drivers.*, users.name, users.email, users.phone,
              vehicles.make_model, vehicles.plate_number, vehicles.vehicle_type, vehicles.seats
       FROM drivers
       JOIN users ON users.id = drivers.user_id
       LEFT JOIN vehicles ON vehicles.id = drivers.vehicle_id
       WHERE drivers.user_id = ?`
    )
    .get(userId);
}

// POST /api/drivers/profile — create or update the driver + vehicle profile.
// Call this once, right after a driver signs up (role must be 'driver').
// body: { licenseNumber, lasdriNumber, spokenLanguages, vehicle: { makeModel, plateNumber, vehicleType, seats } }
router.post("/profile", requireAuth, requireRole("driver"), (req, res) => {
  const { licenseNumber, lasdriNumber, spokenLanguages = "en", vehicle } = req.body;

  let vehicleId = null;
  if (vehicle?.makeModel && vehicle?.plateNumber) {
    const existingDriver = getDriverForUser(req.user.id);
    if (existingDriver?.vehicle_id) {
      db.prepare(
        `UPDATE vehicles SET make_model = ?, plate_number = ?, vehicle_type = ?, seats = ? WHERE id = ?`
      ).run(vehicle.makeModel, vehicle.plateNumber, vehicle.vehicleType || "sedan", vehicle.seats || 4, existingDriver.vehicle_id);
      vehicleId = existingDriver.vehicle_id;
    } else {
      const result = db
        .prepare(
          `INSERT INTO vehicles (owner_user_id, make_model, plate_number, vehicle_type, seats) VALUES (?, ?, ?, ?, ?)`
        )
        .run(req.user.id, vehicle.makeModel, vehicle.plateNumber, vehicle.vehicleType || "sedan", vehicle.seats || 4);
      vehicleId = result.lastInsertRowid;
    }
  }

  const existing = getDriverForUser(req.user.id);
  if (existing) {
    db.prepare(
      `UPDATE drivers SET license_number = ?, lasdri_number = ?, spoken_languages = ?, vehicle_id = COALESCE(?, vehicle_id)
       WHERE user_id = ?`
    ).run(licenseNumber || existing.license_number, lasdriNumber || existing.lasdri_number, spokenLanguages, vehicleId, req.user.id);
  } else {
    db.prepare(
      `INSERT INTO drivers (user_id, vehicle_id, license_number, lasdri_number, spoken_languages) VALUES (?, ?, ?, ?, ?)`
    ).run(req.user.id, vehicleId, licenseNumber || null, lasdriNumber || null, spokenLanguages);
  }

  res.status(201).json({ driver: getDriverWithVehicle(req.user.id) });
});

// GET /api/drivers/me — full driver + vehicle profile
router.get("/me", requireAuth, requireRole("driver"), (req, res) => {
  const driver = getDriverWithVehicle(req.user.id);
  if (!driver) return res.status(404).json({ error: "No driver profile yet — complete it via POST /api/drivers/profile" });
  res.json({ driver });
});

// PATCH /api/drivers/status — toggle online/offline
// body: { isOnline: true|false }
router.patch("/status", requireAuth, requireRole("driver"), (req, res) => {
  const driver = getDriverForUser(req.user.id);
  if (!driver) return res.status(404).json({ error: "Complete your driver profile first" });

  if (req.body.isOnline && !driver.is_verified) {
    return res.status(403).json({ error: "Your account isn't verified yet. An admin needs to approve your driver profile before you can go online." });
  }

  db.prepare("UPDATE drivers SET is_online = ? WHERE id = ?").run(req.body.isOnline ? 1 : 0, driver.id);
  res.json({ isOnline: !!req.body.isOnline });
});

// GET /api/drivers/earnings — total paid earnings + trip count for this driver
router.get("/earnings", requireAuth, requireRole("driver"), (req, res) => {
  const driver = getDriverForUser(req.user.id);
  if (!driver) return res.status(404).json({ error: "Complete your driver profile first" });

  const summary = db
    .prepare(
      `SELECT COUNT(*) as completedTrips, COALESCE(SUM(fare_naira), 0) as totalNaira
       FROM rides WHERE driver_id = ? AND ride_status = 'completed'`
    )
    .get(driver.id);

  const thisMonth = db
    .prepare(
      `SELECT COALESCE(SUM(fare_naira), 0) as totalNaira
       FROM rides WHERE driver_id = ? AND ride_status = 'completed'
       AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')`
    )
    .get(driver.id);

  res.json({
    completedTrips: summary.completedTrips,
    totalNaira: summary.totalNaira,
    thisMonthNaira: thisMonth.totalNaira,
  });
});

module.exports = { router, getDriverForUser, getDriverWithVehicle };
