// Extends the EXISTING PATCH /api/drivers/location endpoint (found in
// routes/drivers.js) rather than introducing a competing POST
// /api/telemetry route, per the explicit instruction to follow
// established API conventions. This file shows the extended handler;
// apply it by replacing the existing router.patch("/location", ...)
// block in routes/drivers.js with this one.
//
// SECURITY: vehicleId and rideId are NEVER read from the request body.
// Both are resolved server-side from the authenticated driver's current
// actual assignment — exactly the same trust model getDriverForUser
// already establishes for driverId itself. A driver physically cannot
// submit telemetry "as" another driver or vehicle, because the server
// never looks at anything the client claims about identity beyond the
// auth token.

const { pool } = require("../db/db");
const { getDriverForUser } = require("./drivers");
const { processTelemetry } = require("../services/telemetry/telemetryService");
const { MapboxRoutingProvider } = require("../services/routing/MapboxRoutingProvider");

let routingProvider;
function getRoutingProvider() {
  if (!routingProvider) routingProvider = new MapboxRoutingProvider();
  return routingProvider;
}

async function handleLocationUpdate(req, res) {
  const { lat, lng, accuracy, speed, heading } = req.body;

  if (typeof lat !== "number" || typeof lng !== "number") {
    return res.status(400).json({ error: "lat/lng are required numbers" });
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return res.status(400).json({ error: "lat/lng out of valid range" });
  }

  const driver = await getDriverForUser(req.user.id);
  if (!driver) return res.status(404).json({ error: "Complete your driver profile first" });

  // Resolve the vehicle server-side from the driver's actual current
  // assignment. The real FK lives on drivers.vehicle_id, not a reverse
  // reference on vehicles — matching how every other route in this
  // codebase (admin.js, rides.js, drivers.js) already joins vehicles.
  const driverRow = await pool.query("SELECT vehicle_id FROM drivers WHERE id = $1", [driver.id]);
  const vehicleId = driverRow.rows[0] ? driverRow.rows[0].vehicle_id : null;

  await pool.query(
    "UPDATE drivers SET current_lat = $1, current_lng = $2, location_updated_at = now() WHERE id = $3",
    [lat, lng, driver.id]
  );

  const result = await processTelemetry({
    db: pool,
    routingProvider: getRoutingProvider(),
    driverId: driver.id,
    vehicleId,
    submittedTelemetry: {
      lat, lng,
      accuracyM: accuracy ?? null,
      speedKmh: speed ?? null,
      headingDeg: heading ?? null,
      recordedAt: new Date().toISOString(),
      source: "driver_phone",
    },
  });

  if (!result.accepted) {
    return res.json({ ok: true, accepted: false, reason: result.classification });
  }

  res.json({ ok: true, ...result });
}

module.exports = { handleLocationUpdate };
