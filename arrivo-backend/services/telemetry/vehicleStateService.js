// Current vehicle state — a fast-read table separate from telemetry
// history (spec section 5). The Live Map reads THIS on every load, never
// the full ride_telemetry history table, which would only grow and get
// slower to query as rides accumulate.

async function upsertVehicleState({ db, vehicleId, telemetry, rideId, driverId, routeState, gpsHealth }) {
  await db.query(
    `INSERT INTO vehicle_current_state
       (vehicle_id, lat, lng, speed_kmh, heading_deg, accuracy_m, source, recorded_at, gps_health, current_ride_id, current_driver_id, route_state, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())
     ON CONFLICT (vehicle_id) DO UPDATE SET
       lat = EXCLUDED.lat, lng = EXCLUDED.lng, speed_kmh = EXCLUDED.speed_kmh,
       heading_deg = EXCLUDED.heading_deg, accuracy_m = EXCLUDED.accuracy_m,
       source = EXCLUDED.source, recorded_at = EXCLUDED.recorded_at,
       gps_health = EXCLUDED.gps_health, current_ride_id = EXCLUDED.current_ride_id,
       current_driver_id = EXCLUDED.current_driver_id, route_state = EXCLUDED.route_state,
       updated_at = now()`,
    [vehicleId, telemetry.lat, telemetry.lng, telemetry.speedKmh, telemetry.headingDeg,
     telemetry.accuracyM, telemetry.source, telemetry.recordedAt, gpsHealth, rideId, driverId, routeState]
  );
}

// GPS health classification (spec section 16 from phase 1, reused here).
// Configurable, not hardcoded per-call, so tuning doesn't mean hunting
// through every caller.
const GPS_HEALTH = { freshSeconds: 30, agingSeconds: 90, staleSeconds: 180 };

function classifyGpsHealth({ lastRecordedAt, now = new Date() }) {
  if (!lastRecordedAt) return "OFFLINE";
  const ageSeconds = (now - new Date(lastRecordedAt)) / 1000;
  if (ageSeconds < GPS_HEALTH.freshSeconds) return "FRESH";
  if (ageSeconds < GPS_HEALTH.agingSeconds) return "AGING";
  if (ageSeconds < GPS_HEALTH.staleSeconds) return "STALE";
  return "OFFLINE";
}

module.exports = { upsertVehicleState, classifyGpsHealth, GPS_HEALTH };
