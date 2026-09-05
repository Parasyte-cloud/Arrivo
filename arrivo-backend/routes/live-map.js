// Live Map snapshot + filtering API.
//
// Base table is `vehicles`, not `rides` — this is what makes a vehicle
// with no active ride still show up as AVAILABLE/OFFLINE rather than
// being invisible until it picks up a trip. Everything else is LEFT
// JOINed from there in ONE query, avoiding the N+1 pattern the spec
// explicitly warns against (vehicle -> ride -> driver -> rider -> route
// -> alert, one query each, per vehicle).

const express = require("express");
const { pool } = require("../db/db");
const { requireAuth, requireAnyRole } = require("../middleware/auth");
const { classifyGpsHealth } = require("../services/telemetry/vehicleStateService");

const router = express.Router();
router.use(requireAuth, requireAnyRole(["admin", "support", "operations"]));

router.get("/snapshot", async (req, res) => {
  const { filter, search } = req.query;

  const conditions = ["vehicles.active = true"];
  const params = [];
  let i = 1;

  if (search) {
    conditions.push(`(vehicles.plate_number ILIKE $${i} OR driver_user.name ILIKE $${i} OR rider_user.name ILIKE $${i} OR rides.id::text = $${i + 1})`);
    params.push(`%${search}%`, search);
    i += 2;
  }

  // Server-side filters, per spec section 11 — never "send everything,
  // filter in the browser".
  if (filter === "active_rides") conditions.push(`rides.id IS NOT NULL AND rides.ride_status IN ('accepted','in_progress')`);
  if (filter === "available") conditions.push(`vehicles.status = 'AVAILABLE'`);
  if (filter === "offline") conditions.push(`vehicle_current_state.gps_health = 'OFFLINE'`);
  if (filter === "gps_stale") conditions.push(`vehicle_current_state.gps_health = 'STALE'`);
  if (filter === "route_deviation") conditions.push(`safety_alerts.id IS NOT NULL AND safety_alerts.type = 'ROUTE_DEVIATION'`);
  if (filter === "critical_alerts") conditions.push(`safety_alerts.severity = 'CRITICAL'`);
  if (filter === "panic") conditions.push(`rides.panic_triggered_at IS NOT NULL AND rides.panic_resolved_at IS NULL`);

  const whereClause = `WHERE ${conditions.join(" AND ")}`;

  const result = await pool.query(
    `SELECT
       vehicles.id as vehicle_id, vehicles.plate_number, vehicles.make_model, vehicles.status as vehicle_status,
       vehicle_current_state.lat, vehicle_current_state.lng, vehicle_current_state.speed_kmh,
       vehicle_current_state.heading_deg, vehicle_current_state.accuracy_m, vehicle_current_state.source,
       vehicle_current_state.recorded_at, vehicle_current_state.gps_health, vehicle_current_state.route_state,
       rides.id as ride_id, rides.pickup_address, rides.ride_status, rides.route_version,
       rides.route_distance_km, rides.route_duration_min, rides.panic_triggered_at,
       driver_user.id as driver_id, driver_user.name as driver_name, driver_user.phone as driver_phone,
       rider_user.id as rider_id, rider_user.name as rider_name, rider_user.phone as rider_phone,
       safety_alerts.id as alert_id, safety_alerts.severity as alert_severity, safety_alerts.status as alert_status
     FROM vehicles
     LEFT JOIN vehicle_current_state ON vehicle_current_state.vehicle_id = vehicles.id
     LEFT JOIN drivers ON drivers.vehicle_id = vehicles.id
     LEFT JOIN users driver_user ON driver_user.id = drivers.user_id
     LEFT JOIN rides ON rides.id = vehicle_current_state.current_ride_id
     LEFT JOIN users rider_user ON rider_user.id = rides.rider_id
     LEFT JOIN safety_alerts ON safety_alerts.ride_id = rides.id AND safety_alerts.status IN ('OPEN','ACKNOWLEDGED','INVESTIGATING')
     ${whereClause}
     ORDER BY vehicles.id
     LIMIT 500`,
    params
  );

  // Reshape into the operational payload shape from the spec — not raw
  // rows, and every location explicitly carries updatedAt/source/accuracy
  // so the frontend can judge freshness itself rather than assume "shown
  // = current" (spec sections 28-29).
  const vehicles = result.rows.map((row) => ({
    vehicle: { id: row.vehicle_id, plate: row.plate_number, makeModel: row.make_model, status: row.vehicle_status },
    location: row.lat != null ? {
      lat: row.lat, lng: row.lng, speed: row.speed_kmh, heading: row.heading_deg,
      accuracy: row.accuracy_m, source: row.source, updatedAt: row.recorded_at,
      gpsStatus: row.gps_health || classifyGpsHealth({ lastRecordedAt: row.recorded_at }),
    } : null, // explicit null, not [] — spec section 29
    assignment: {
      driver: row.driver_id ? { id: row.driver_id, name: row.driver_name, phone: row.driver_phone } : null,
      ride: row.ride_id ? { id: row.ride_id, status: row.ride_status, pickup: row.pickup_address } : null,
      rider: row.rider_id ? { id: row.rider_id, name: row.rider_name, phone: row.rider_phone } : null,
    },
    route: row.ride_id ? {
      version: row.route_version, state: row.route_state || "ROUTE_UNAVAILABLE",
      distanceRemainingKm: row.route_distance_km, etaMin: row.route_duration_min,
    } : null,
    safety: {
      state: row.panic_triggered_at ? "PANIC" : (row.alert_severity || "NORMAL"),
      alert: row.alert_id ? { id: row.alert_id, severity: row.alert_severity, status: row.alert_status } : null,
    },
  }));

  const summary = {
    totalVehicles: vehicles.length,
    activeRides: vehicles.filter((v) => v.assignment.ride && ["accepted", "in_progress"].includes(v.assignment.ride.status)).length,
    available: vehicles.filter((v) => v.vehicle.status === "AVAILABLE").length,
    offline: vehicles.filter((v) => v.location?.gpsStatus === "OFFLINE").length,
    gpsStale: vehicles.filter((v) => v.location?.gpsStatus === "STALE").length,
    routeAlerts: vehicles.filter((v) => v.safety.alert && v.safety.alert.severity !== "PANIC").length,
    panicAlerts: vehicles.filter((v) => v.safety.state === "PANIC").length,
  };

  res.json({ summary, vehicles, generatedAt: new Date().toISOString() });
});

module.exports = router;
