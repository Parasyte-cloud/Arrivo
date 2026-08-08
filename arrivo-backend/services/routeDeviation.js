// Route-deviation detection engine (spec section 6).
//
// Deliberately NOT `if (distanceFromRoute > X) alert()` — that produces
// an alert storm on real Lagos roads (traffic diversions, one-ways,
// pickup positioning) and gets ignored within a week. Every signal below
// exists because a naive version of this specific check produces false
// positives in a documented, common driving situation.

const THRESHOLDS = {
  // Distance bands, in meters, from the route geometry (spec 6A).
  normalM: 50,
  warningM: 150,
  deviationM: 150,
  criticalM: 300,

  // A GPS fix is not trustworthy beyond its own accuracy radius (spec
  // 6B). If accuracy_m is 250 and distance_from_route is 180, the fix
  // could genuinely BE on the route — the device just doesn't know
  // precisely enough to say so. We subtract accuracy from the raw
  // distance before comparing against the bands above, rather than
  // ignoring accuracy entirely.
  maxTrustedAccuracyM: 300, // beyond this, don't evaluate deviation at all this sample

  // Persistence (spec 6C) — a state only escalates after BOTH enough
  // consecutive off-route samples AND enough elapsed time, whichever is
  // stricter, so a single bad GPS fix or a five-second signal dropout
  // can never alone trigger an alert.
  minConsecutiveSamples: 3,
  minPersistenceSeconds: 30,

  // Section 6E — a stationary vehicle (parked, loading, waiting at a
  // gate) should never accumulate deviation the way a moving one would.
  stationarySpeedKmh: 3,
};

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

function haversineMeters(a, b) {
  const R = 6371000;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function distanceToPolylineMeters(point, polyline) {
  if (!polyline || polyline.length === 0) return null;
  if (polyline.length === 1) return haversineMeters(point, polyline[0]);

  let min = Infinity;
  for (let i = 0; i < polyline.length - 1; i++) {
    const d = distanceToSegmentMeters(point, polyline[i], polyline[i + 1]);
    if (d < min) min = d;
  }
  return min;
}

function distanceToSegmentMeters(point, segStart, segEnd) {
  const latMid = toRad((segStart.lat + segEnd.lat) / 2);
  const mPerDegLat = 111320;
  const mPerDegLng = 111320 * Math.cos(latMid);

  const toXY = (p) => ({
    x: (p.lng - segStart.lng) * mPerDegLng,
    y: (p.lat - segStart.lat) * mPerDegLat,
  });

  const p = toXY(point);
  const end = toXY(segEnd);

  const segLenSq = end.x ** 2 + end.y ** 2;
  let t = segLenSq === 0 ? 0 : (p.x * end.x + p.y * end.y) / segLenSq;
  t = Math.max(0, Math.min(1, t));

  const closest = { lat: segStart.lat + t * (segEnd.lat - segStart.lat), lng: segStart.lng + t * (segEnd.lng - segStart.lng) };
  return haversineMeters(point, closest);
}

function bearingDeg(a, b) {
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLng = toRad(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  const deg = (Math.atan2(y, x) * 180) / Math.PI;
  return (deg + 360) % 360;
}

function headingDeltaDeg(a, b) {
  const diff = Math.abs(a - b) % 360;
  return diff > 180 ? 360 - diff : diff;
}

/**
 * Evaluates one telemetry sample against a ride's planned route and
 * current deviation state, and returns the next state plus enough detail
 * to write both a deviation-state update and, if the state changed, a
 * timeline event.
 *
 * This function is pure — no DB access — specifically so it can be unit
 * tested against the exact scenarios spec section 28 asks for (20m away,
 * 100m away, poor GPS accuracy, stationary vehicle, etc.) without a
 * database in the loop at all.
 */
function evaluateTelemetry({ telemetry, route, destination, currentState, thresholds = THRESHOLDS }) {
  const { lat, lng, accuracyM, speedKmh, recordedAt } = telemetry;
  const point = { lat, lng };

  if (accuracyM != null && accuracyM > thresholds.maxTrustedAccuracyM) {
    return {
      state: currentState.state,
      distanceFromRouteM: currentState.distanceFromRouteM,
      distanceFromDestinationKm: currentState.distanceFromDestinationKm,
      consecutiveOffRouteSamples: currentState.consecutiveOffRouteSamples,
      changed: false,
      skippedReason: `GPS accuracy too poor to evaluate (±${accuracyM}m)`,
    };
  }

  const rawDistanceM = distanceToPolylineMeters(point, route);
  const effectiveDistanceM = accuracyM ? Math.max(0, rawDistanceM - accuracyM) : rawDistanceM;
  const distanceFromDestinationKm = destination ? haversineMeters(point, destination) / 1000 : null;

  const isStationary = speedKmh != null && speedKmh < thresholds.stationarySpeedKmh;

  if (isStationary) {
    return {
      state: currentState.state,
      distanceFromRouteM: effectiveDistanceM,
      distanceFromDestinationKm,
      consecutiveOffRouteSamples: currentState.consecutiveOffRouteSamples,
      changed: false,
      skippedReason: "Vehicle stationary — not accumulating deviation",
    };
  }

  const isOffRoute = effectiveDistanceM > thresholds.deviationM;
  const consecutiveOffRouteSamples = isOffRoute ? currentState.consecutiveOffRouteSamples + 1 : 0;

  const secondsInCurrentState = currentState.stateEnteredAt
    ? (new Date(recordedAt) - new Date(currentState.stateEnteredAt)) / 1000
    : 0;

  const persistenceMet =
    consecutiveOffRouteSamples >= thresholds.minConsecutiveSamples &&
    secondsInCurrentState >= thresholds.minPersistenceSeconds;

  let nextState = currentState.state;

  if (!isOffRoute) {
    nextState = "ON_ROUTE";
  } else if (effectiveDistanceM > thresholds.criticalM && persistenceMet) {
    nextState = "CRITICAL_ROUTE_DEVIATION";
  } else if (persistenceMet) {
    nextState = "PERSISTENT_OFF_ROUTE";
  } else if (consecutiveOffRouteSamples >= 1) {
    if (currentState.state === "ON_ROUTE") {
      nextState = "POSSIBLE_DEVIATION";
    } else if (currentState.state === "POSSIBLE_DEVIATION" && secondsInCurrentState > 15) {
      nextState = "OFF_ROUTE";
    }
  }

  return {
    state: nextState,
    distanceFromRouteM: effectiveDistanceM,
    distanceFromDestinationKm,
    consecutiveOffRouteSamples,
    changed: nextState !== currentState.state,
  };
}

module.exports = {
  THRESHOLDS,
  haversineMeters,
  distanceToPolylineMeters,
  bearingDeg,
  headingDeltaDeg,
  evaluateTelemetry,
};

// ---------------------------------------------------------------------
// Route intent (deviation vs. legitimate rerouting) — added per review.
//
// The question this answers is different from "how far off the route
// polyline is the vehicle": it's "is the vehicle's actual trajectory
// still consistent with reaching the destination". A vehicle can be
// 300m off the original polyline and be completely fine (road closure,
// legitimate alternate street) or right ON the polyline's general
// bearing and still be a real problem if it's crawling backward along
// it. Distance-from-route and distance-from-destination are both
// necessary signals; neither is sufficient alone — this function is what
// combines them into an actual intent classification.
// ---------------------------------------------------------------------

const INTENT_THRESHOLDS = {
  // A destination-distance trend is only meaningful over a real window —
  // a single sample can go up or down from GPS noise alone even while
  // genuinely approaching. Require several samples showing a consistent
  // direction before drawing a conclusion from the trend.
  minSamplesForTrend: 4,
  // If distance-to-destination has *increased* by at least this much
  // across the trend window, treat that as "moving away", not noise.
  movingAwayThresholdKm: 0.15,
};

/**
 * Classifies WHY a vehicle is off-route, given its recent
 * distance-to-destination history (oldest first) plus its current
 * off-route state. Pure function, no DB access, same testing philosophy
 * as evaluateTelemetry.
 *
 * recentDestinationDistancesKm: array of distance-to-destination-km
 * samples from the last N telemetry points, oldest to newest.
 */
function classifyRouteIntent({ deviationState, recentDestinationDistancesKm, thresholds = INTENT_THRESHOLDS }) {
  if (deviationState === "ON_ROUTE" || deviationState === "POSSIBLE_DEVIATION") {
    // Not off-route long enough yet to reason about intent at all —
    // this matches the state machine's own persistence gating.
    return { intent: "NOT_APPLICABLE", reason: "Not yet in a sustained off-route state" };
  }

  if (!recentDestinationDistancesKm || recentDestinationDistancesKm.length < thresholds.minSamplesForTrend) {
    return { intent: "INSUFFICIENT_DATA", reason: "Not enough recent samples to evaluate trajectory trend" };
  }

  const first = recentDestinationDistancesKm[0];
  const last = recentDestinationDistancesKm[recentDestinationDistancesKm.length - 1];
  const trendKm = last - first; // negative = getting closer, positive = getting farther

  // Section 7 explicitly warns against flagging on a single momentary
  // increase — check the trend is consistently in one direction, not
  // just that the endpoints differ (a single U-turn sample shouldn't
  // count as "moving away" if the rest of the window is approaching).
  let increasingSteps = 0;
  for (let i = 1; i < recentDestinationDistancesKm.length; i++) {
    if (recentDestinationDistancesKm[i] > recentDestinationDistancesKm[i - 1]) increasingSteps++;
  }
  const mostlyIncreasing = increasingSteps >= recentDestinationDistancesKm.length - 2;

  if (trendKm <= -thresholds.movingAwayThresholdKm) {
    return {
      intent: "VALID_ALTERNATIVE",
      reason: `Off original route but distance to destination decreased ${Math.abs(trendKm).toFixed(2)}km over the window — consistent with a legitimate alternate path`,
    };
  }

  if (trendKm >= thresholds.movingAwayThresholdKm && mostlyIncreasing) {
    return deviationState === "CRITICAL_ROUTE_DEVIATION"
      ? { intent: "CRITICAL", reason: `Persistently moving away from destination (+${trendKm.toFixed(2)}km over the window) with no evidence of a valid alternate path` }
      : { intent: "SUSPICIOUS", reason: `Distance to destination increased ${trendKm.toFixed(2)}km and the trend is consistent, not a single noisy sample` };
  }

  return {
    intent: "TEMPORARY_DEVIATION",
    reason: "Off route, but destination distance trend is flat or ambiguous — not enough evidence yet to classify as valid reroute or suspicious",
  };
}

module.exports.classifyRouteIntent = classifyRouteIntent;
module.exports.INTENT_THRESHOLDS = INTENT_THRESHOLDS;
