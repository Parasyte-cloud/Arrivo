// Alert Center API — follows this codebase's real, verified conventions:
// requireAuth + requireAnyRole(["admin","support"]) applied once at
// router level (matching admin.js), mutations additionally gated by
// requireRole("admin") on top (support is read-only, same pattern as
// admin.js's driver-verification routes), pool imported directly (not
// req.pool, which doesn't exist anywhere in this codebase).

const express = require("express");
const { pool } = require("../db/db");
const { requireAuth, requireRole, requireAnyRole } = require("../middleware/auth");
const { transitionAlert, InvalidAlertTransitionError } = require("../services/telemetry/alertService");

const router = express.Router();
router.use(requireAuth, requireAnyRole(["admin", "support"]));

// GET /api/alerts — list, filtered, paginated.
// Follows the existing LIMIT-based pagination convention seen in
// routes/admin.js (LIMIT 100/200) rather than introducing cursor-based
// pagination unprompted — the spec explicitly says to use the existing
// convention if one exists, and one does.
router.get("/", async (req, res) => {
  const { severity, status, type, vehicleId, rideId, driverId, from, to } = req.query;
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  // Default to open/active alerts, not unlimited history — per spec.
  const conditions = [];
  const params = [];
  let paramIndex = 1;

  if (status) {
    conditions.push(`safety_alerts.status = $${paramIndex++}`);
    params.push(status);
  } else {
    conditions.push(`safety_alerts.status IN ('OPEN', 'ACKNOWLEDGED', 'INVESTIGATING')`);
  }
  if (severity) { conditions.push(`safety_alerts.severity = $${paramIndex++}`); params.push(severity); }
  if (type) { conditions.push(`safety_alerts.type = $${paramIndex++}`); params.push(type); }
  if (rideId) { conditions.push(`safety_alerts.ride_id = $${paramIndex++}`); params.push(rideId); }
  if (driverId) { conditions.push(`rides.driver_id = $${paramIndex++}`); params.push(driverId); }
  if (from) { conditions.push(`safety_alerts.created_at >= $${paramIndex++}`); params.push(from); }
  if (to) { conditions.push(`safety_alerts.created_at <= $${paramIndex++}`); params.push(to); }

  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  // Single joined query rather than N+1 — pulls ride/driver/rider context
  // in one round trip, matching spec section 9's explicit requirement.
  const result = await pool.query(
    `SELECT safety_alerts.*,
            rides.pickup_address, rides.driver_id, rides.rider_id,
            drivers_user.name as driver_name, drivers_user.phone as driver_phone,
            riders_user.name as rider_name, riders_user.phone as rider_phone,
            vehicles.plate_number, vehicles.make_model
     FROM safety_alerts
     JOIN rides ON rides.id = safety_alerts.ride_id
     LEFT JOIN drivers ON drivers.id = rides.driver_id
     LEFT JOIN users drivers_user ON drivers_user.id = drivers.user_id
     LEFT JOIN users riders_user ON riders_user.id = rides.rider_id
     LEFT JOIN vehicles ON vehicles.id = drivers.vehicle_id
     ${whereClause}
     ORDER BY safety_alerts.created_at DESC
     LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
    [...params, limit, offset]
  );

  res.json({ alerts: result.rows, limit, offset });
});

// GET /api/alerts/:id — full detail, including timeline.
router.get("/:id", async (req, res) => {
  const alertResult = await pool.query(
    `SELECT safety_alerts.*, rides.pickup_address, rides.driver_id, rides.rider_id,
            rides.route_geometry, rides.route_version
     FROM safety_alerts JOIN rides ON rides.id = safety_alerts.ride_id
     WHERE safety_alerts.id = $1`,
    [req.params.id]
  );
  const alert = alertResult.rows[0];
  if (!alert) return res.status(404).json({ error: "Alert not found" });

  // Timeline: the deviation events for this ride, not raw telemetry —
  // per spec section 4, meaningful events only, not every GPS point.
  const timeline = await pool.query(
    `SELECT from_state, to_state, distance_from_route_m, lat, lng, note, created_at
     FROM route_deviation_events WHERE ride_id = $1 ORDER BY created_at ASC`,
    [alert.ride_id]
  );

  const vehicleState = await pool.query(
    `SELECT lat, lng, speed_kmh, heading_deg, accuracy_m, gps_health, route_state, updated_at
     FROM vehicle_current_state WHERE current_ride_id = $1`,
    [alert.ride_id]
  );

  res.json({ alert, timeline: timeline.rows, currentVehicleState: vehicleState.rows[0] || null });
});

// State mutations — controller calls the existing AlertService; no
// transition logic duplicated here, per spec section 5.
async function transition(req, res, toStatus) {
  const alertResult = await pool.query("SELECT id, status FROM safety_alerts WHERE id = $1", [req.params.id]);
  const alert = alertResult.rows[0];
  if (!alert) return res.status(404).json({ error: "Alert not found" });

  try {
    const result = await transitionAlert({
      db: pool, alertId: alert.id, currentStatus: alert.status, toStatus,
      resolutionReason: req.body.note || req.body.reason || null,
    });
    res.json(result);
  } catch (e) {
    if (e instanceof InvalidAlertTransitionError) {
      return res.status(409).json({ error: e.message });
    }
    throw e;
  }
}

router.post("/:id/acknowledge", requireRole("admin"), (req, res) => transition(req, res, "ACKNOWLEDGED"));
router.post("/:id/investigate", requireRole("admin"), (req, res) => transition(req, res, "INVESTIGATING"));
router.post("/:id/resolve", requireRole("admin"), (req, res) => transition(req, res, "RESOLVED"));
router.post("/:id/dismiss", requireRole("admin"), (req, res) => transition(req, res, "DISMISSED"));

module.exports = router;
