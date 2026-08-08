// The orchestrator. Implements the exact processing order the spec
// requires (validate cheaply first, only do expensive route work after).
// This file coordinates; it does not contain deviation math, intent
// logic, or alert rules itself — those stay in their own tested modules
// so the orchestration can be read top-to-bottom as a checklist, and so
// each piece stays independently testable.

const { validateTelemetry } = require("../telemetryValidation");
const { evaluateTelemetry, classifyRouteIntent } = require("../routeDeviation");
const { evaluateAndPossiblyReroute } = require("../routeService");
const { upsertVehicleState, classifyGpsHealth } = require("./vehicleStateService");
const { upsertAlert, autoResolveAlert } = require("./alertService");
const { publish } = require("./eventService");

const ALERT_TYPE = "ROUTE_DEVIATION";
const SEVERITY_BY_STATE = {
  POSSIBLE_DEVIATION: null, // not alert-worthy yet — this is exactly the point of the persistence gate
  OFF_ROUTE: "MEDIUM",
  PERSISTENT_OFF_ROUTE: "HIGH",
  CRITICAL_ROUTE_DEVIATION: "CRITICAL",
};

/**
 * The single entry point the Express controller calls. `db` is the
 * minimal { query(sql, params) } interface used throughout this project
 * — this function never imports a DB driver directly, which is what
 * makes it possible to run against a fake in-memory store in tests
 * without spinning up a real Postgres instance.
 */
async function processTelemetry({ db, routingProvider, driverId, vehicleId, submittedTelemetry, now = new Date() }) {
  // Steps 3-9: validate before touching anything expensive.
  const previousSample = await getLastTelemetry({ db, vehicleId });
  const validation = validateTelemetry({ sample: submittedTelemetry, previousSample, now });

  if (!validation.valid) {
    return { accepted: false, reason: validation.reason, classification: validation.classification };
  }

  // Step 10: persist raw telemetry — this happens regardless of whether
  // an active ride exists, since fleet-wide vehicle health monitoring
  // (spec section 6) needs it too.
  await db.query(
    `INSERT INTO ride_telemetry (ride_id, source, lat, lng, accuracy_m, speed_kmh, heading_deg, recorded_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [submittedTelemetry.rideId || null, submittedTelemetry.source || "driver_phone",
     submittedTelemetry.lat, submittedTelemetry.lng, submittedTelemetry.accuracyM,
     submittedTelemetry.speedKmh, submittedTelemetry.headingDeg, submittedTelemetry.recordedAt]
  );

  // Step 12: resolve active ride SERVER-SIDE — the caller does not get
  // to declare "this telemetry belongs to ride X"; we look it up from
  // who the vehicle/driver is actually currently assigned to.
  const activeRide = await resolveActiveRide({ db, driverId, vehicleId });

  const gpsHealth = classifyGpsHealth({ lastRecordedAt: submittedTelemetry.recordedAt });

  if (!activeRide) {
    // Section 6: no active ride — update fleet vehicle location and
    // health, but do not run ride-level deviation/intent logic at all.
    await upsertVehicleState({
      db, vehicleId, telemetry: submittedTelemetry, rideId: null, driverId, routeState: null, gpsHealth,
    });
    publish("vehicle.location.updated", { vehicleId, lat: submittedTelemetry.lat, lng: submittedTelemetry.lng, gpsHealth });
    return { accepted: true, rideCorrelation: "NO_ACTIVE_RIDE" };
  }

  // Step 13: resolve active route.
  if (!activeRide.routeGeometry) {
    // Ride is active but has no route yet (e.g. route generation hasn't
    // run, or the routing provider was unavailable at ride start) —
    // still update vehicle state, but there's nothing to evaluate
    // deviation against yet.
    await upsertVehicleState({ db, vehicleId, telemetry: submittedTelemetry, rideId: activeRide.id, driverId, routeState: "NO_ROUTE", gpsHealth });
    return { accepted: true, rideCorrelation: "ACTIVE_RIDE", routeState: "NO_ROUTE" };
  }

  // Step 14: deviation engine.
  const currentDeviationState = await getDeviationState({ db, rideId: activeRide.id });
  const deviationResult = evaluateTelemetry({
    telemetry: submittedTelemetry,
    route: activeRide.routeGeometry,
    destination: activeRide.destination,
    currentState: currentDeviationState,
  });

  await persistDeviationState({ db, rideId: activeRide.id, previous: currentDeviationState, result: deviationResult, telemetry: submittedTelemetry });

  let intentResult = { intent: "NOT_APPLICABLE" };
  let rerouteResult = { rerouted: false };

  if (deviationResult.changed || ["OFF_ROUTE", "PERSISTENT_OFF_ROUTE", "CRITICAL_ROUTE_DEVIATION"].includes(deviationResult.state)) {
    // Step 15: intent — only meaningful once actually off-route.
    const recentDistances = await getRecentDestinationDistances({ db, rideId: activeRide.id });
    intentResult = classifyRouteIntent({ deviationState: deviationResult.state, recentDestinationDistancesKm: recentDistances });

    // Step 16: reroute if intent supports it.
    rerouteResult = await evaluateAndPossiblyReroute({
      db, routingProvider, rideId: activeRide.id, intentResult,
      currentVehiclePosition: { lat: submittedTelemetry.lat, lng: submittedTelemetry.lng },
      destination: activeRide.destination,
      lastRouteGeneratedAt: activeRide.routeGeneratedAt,
      currentRouteVersion: activeRide.routeVersion,
    });
  }

  // Step 17: alert evaluation — only for states that are actually
  // alert-worthy per SEVERITY_BY_STATE; ON_ROUTE and POSSIBLE_DEVIATION
  // never create or touch an alert at all.
  let alertResult = null;
  if (deviationResult.state === "ON_ROUTE" && currentDeviationState.state !== "ON_ROUTE") {
    // Recovery — auto-resolve any open alert for this ride.
    const openAlert = await getOpenAlert({ db, rideId: activeRide.id, type: ALERT_TYPE });
    if (openAlert) {
      alertResult = await autoResolveAlert({ db, alertId: openAlert.id, currentStatus: openAlert.status, finalLat: submittedTelemetry.lat, finalLng: submittedTelemetry.lng });
      publish("route.deviation.resolved", { rideId: activeRide.id, alertId: openAlert.id });
    }
  } else if (!rerouteResult.rerouted && SEVERITY_BY_STATE[deviationResult.state]) {
    alertResult = await upsertAlert({
      db, rideId: activeRide.id, type: ALERT_TYPE, severity: SEVERITY_BY_STATE[deviationResult.state],
      telemetry: submittedTelemetry, distanceFromRouteM: deviationResult.distanceFromRouteM,
      distanceFromDestinationKm: deviationResult.distanceFromDestinationKm,
    });
    // Step 18/19: only publish an event when something actually changed
    // — never on every telemetry tick, per spec section 13.
    if (alertResult.created) {
      publish("route.deviation.started", { rideId: activeRide.id, alertId: alertResult.alertId, severity: alertResult.severity });
      publish("alert.created", { rideId: activeRide.id, alertId: alertResult.alertId, severity: alertResult.severity });
    } else if (alertResult.escalated) {
      publish("route.deviation.escalated", { rideId: activeRide.id, alertId: alertResult.alertId, severity: alertResult.severity });
      publish("alert.updated", { rideId: activeRide.id, alertId: alertResult.alertId, severity: alertResult.severity });
    }
  }

  if (rerouteResult.rerouted) {
    publish("route.changed", { rideId: activeRide.id, newVersion: rerouteResult.newVersion });
  }

  await upsertVehicleState({
    db, vehicleId, telemetry: submittedTelemetry, rideId: activeRide.id, driverId,
    routeState: deviationResult.state, gpsHealth,
  });
  publish("ride.location.updated", { rideId: activeRide.id, lat: submittedTelemetry.lat, lng: submittedTelemetry.lng, routeState: deviationResult.state });

  return {
    accepted: true,
    rideCorrelation: "ACTIVE_RIDE",
    deviationState: deviationResult.state,
    intent: intentResult.intent,
    rerouted: rerouteResult.rerouted,
    alert: alertResult,
  };
}

// --- DB helper functions, isolated here so telemetryService's own logic
// stays readable and so tests can supply a fake db without needing a
// real SQL engine underneath these specific queries. ---

async function getLastTelemetry({ db, vehicleId }) {
  const r = await db.query(
    `SELECT lat, lng, recorded_at as "recordedAt" FROM ride_telemetry
     WHERE ride_id IN (SELECT current_ride_id FROM vehicle_current_state WHERE vehicle_id = $1)
     ORDER BY recorded_at DESC LIMIT 1`,
    [vehicleId]
  );
  return r.rows && r.rows[0] ? r.rows[0] : null;
}

async function resolveActiveRide({ db, driverId, vehicleId }) {
  const r = await db.query(
    `SELECT id, route_geometry as "routeGeometry", route_version as "routeVersion",
            route_generated_at as "routeGeneratedAt", dropoff_lat, dropoff_lng
     FROM rides WHERE driver_id = $1 AND ride_status IN ('accepted', 'in_progress') LIMIT 1`,
    [driverId]
  );
  if (!r.rows || !r.rows[0]) return null;
  const row = r.rows[0];
  return {
    ...row,
    routeGeometry: row.routeGeometry ? (typeof row.routeGeometry === "string" ? JSON.parse(row.routeGeometry) : row.routeGeometry) : null,
    destination: row.dropoff_lat != null ? { lat: row.dropoff_lat, lng: row.dropoff_lng } : null,
  };
}

async function getDeviationState({ db, rideId }) {
  const r = await db.query(
    `SELECT state, distance_from_route_m as "distanceFromRouteM", distance_from_destination_km as "distanceFromDestinationKm",
            state_entered_at as "stateEnteredAt", consecutive_off_route_samples as "consecutiveOffRouteSamples"
     FROM route_deviation_state WHERE ride_id = $1`,
    [rideId]
  );
  return r.rows && r.rows[0] ? r.rows[0] : { state: "ON_ROUTE", distanceFromRouteM: null, distanceFromDestinationKm: null, stateEnteredAt: null, consecutiveOffRouteSamples: 0 };
}

async function persistDeviationState({ db, rideId, previous, result, telemetry }) {
  const stateEnteredAt = result.changed ? telemetry.recordedAt : (previous.stateEnteredAt || telemetry.recordedAt);
  await db.query(
    `INSERT INTO route_deviation_state (ride_id, state, distance_from_route_m, distance_from_destination_km, state_entered_at, last_evaluated_at, consecutive_off_route_samples)
     VALUES ($1, $2, $3, $4, $5, now(), $6)
     ON CONFLICT (ride_id) DO UPDATE SET
       state = EXCLUDED.state, distance_from_route_m = EXCLUDED.distance_from_route_m,
       distance_from_destination_km = EXCLUDED.distance_from_destination_km,
       state_entered_at = EXCLUDED.state_entered_at, last_evaluated_at = now(),
       consecutive_off_route_samples = EXCLUDED.consecutive_off_route_samples`,
    [rideId, result.state, result.distanceFromRouteM, result.distanceFromDestinationKm, stateEnteredAt, result.consecutiveOffRouteSamples]
  );

  if (result.changed) {
    await db.query(
      `INSERT INTO route_deviation_events (ride_id, from_state, to_state, distance_from_route_m, lat, lng, gps_accuracy_m)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [rideId, previous.state, result.state, result.distanceFromRouteM, telemetry.lat, telemetry.lng, telemetry.accuracyM]
    );
  }
}

async function getRecentDestinationDistances({ db, rideId, limit = 5 }) {
  const r = await db.query(
    `SELECT distance_from_destination_km as d FROM route_deviation_events
     WHERE ride_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [rideId, limit]
  );
  return (r.rows || []).map((row) => row.d).reverse();
}

async function getOpenAlert({ db, rideId, type }) {
  const r = await db.query(
    `SELECT id, status FROM safety_alerts WHERE ride_id = $1 AND type = $2 AND status IN ('OPEN', 'ACKNOWLEDGED', 'INVESTIGATING') LIMIT 1`,
    [rideId, type]
  );
  return r.rows && r.rows[0] ? r.rows[0] : null;
}

module.exports = { processTelemetry };
