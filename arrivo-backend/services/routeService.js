// Route generation, versioning, and controlled recalculation.
//
// Two things this deliberately protects against, per the review:
// (1) treating a legitimate reroute as a safety incident, and
// (2) calling the routing API on every GPS sample, which is both a real
//     cost problem and unnecessary — routes don't need to be
//     regenerated more than a few times per ride at most.

const RECALC_COOLDOWN_SECONDS = 90; // minimum time between route recalculations for the same ride

/**
 * Generates and persists the initial route for a ride. Called once, at
 * ride start. `db` is a minimal query interface ({ query(sql, params) })
 * so this function has no hard dependency on any specific driver.
 */
async function generateInitialRoute({ db, routingProvider, rideId, pickup, destination, providerName }) {
  const route = await routingProvider.getRoute(pickup, destination);

  await db.query(
    `UPDATE rides SET
       route_geometry = $1, route_distance_km = $2, route_duration_min = $3,
       route_version = 1, route_generated_at = now(), route_provider = $4
     WHERE id = $5`,
    [JSON.stringify(route.geometry), route.distanceKm, route.durationMin, providerName, rideId]
  );

  return { ...route, version: 1 };
}

/**
 * Decides whether a ride is eligible for route recalculation right now,
 * enforcing the cooldown independent of anything else — this is checked
 * BEFORE ever calling the routing provider, so a provider outage or a
 * burst of off-route samples can never turn into a burst of API calls.
 */
function isRecalcEligible({ lastRouteGeneratedAt, now = new Date() }) {
  if (!lastRouteGeneratedAt) return true;
  const secondsSinceLastRoute = (now - new Date(lastRouteGeneratedAt)) / 1000;
  return secondsSinceLastRoute >= RECALC_COOLDOWN_SECONDS;
}

/**
 * The actual "should we treat this as a reroute or an incident" decision,
 * per the review's ON_ROUTE -> ... -> EVALUATE_ALTERNATIVE -> (VALID_ALTERNATIVE | ALERT)
 * flow. Combines the intent classification with recalc eligibility and
 * the routing provider itself — if intent says VALID_ALTERNATIVE, this is
 * where a new route actually gets generated and promoted to active,
 * superseding the old one WITHOUT deleting it.
 */
async function evaluateAndPossiblyReroute({ db, routingProvider, rideId, intentResult, currentVehiclePosition, destination, lastRouteGeneratedAt, currentRouteVersion }) {
  if (intentResult.intent !== "VALID_ALTERNATIVE") {
    return { rerouted: false, reason: "Intent classification did not indicate a valid alternate path" };
  }

  if (!isRecalcEligible({ lastRouteGeneratedAt })) {
    return { rerouted: false, reason: `Recalculation cooldown active (${RECALC_COOLDOWN_SECONDS}s between reroutes)` };
  }

  let newRoute;
  try {
    newRoute = await routingProvider.getRoute(currentVehiclePosition, destination);
  } catch (e) {
    // Provider failure while trying to reroute — per review section 18,
    // this must never delete the current route or escalate to a false
    // critical alert. Fall through to the caller's existing deviation
    // handling; the old route stays active.
    return { rerouted: false, reason: `Routing provider unavailable: ${e.message}`, providerUnavailable: true, retryable: e.retryable };
  }

  const nextVersion = currentRouteVersion + 1;
  await db.query(
    `UPDATE rides SET
       route_geometry = $1, route_distance_km = $2, route_duration_min = $3,
       route_version = $4, route_generated_at = now()
     WHERE id = $5`,
    [JSON.stringify(newRoute.geometry), newRoute.distanceKm, newRoute.durationMin, nextVersion, rideId]
  );

  await db.query(
    `INSERT INTO route_deviation_events (ride_id, from_state, to_state, note)
     VALUES ($1, 'OFF_ROUTE', 'ON_ROUTE', $2)`,
    [rideId, `Route recalculated (v${currentRouteVersion} -> v${nextVersion}): ${intentResult.reason}`]
  );

  return { rerouted: true, newVersion: nextVersion, route: newRoute };
}

module.exports = { RECALC_COOLDOWN_SECONDS, generateInitialRoute, isRecalcEligible, evaluateAndPossiblyReroute };
