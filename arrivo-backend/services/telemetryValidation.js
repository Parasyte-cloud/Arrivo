// Telemetry validation — the gate every incoming GPS sample passes
// through before it's trusted by anything downstream. Per spec: reject
// or quarantine, but always classify WHY, never just silently drop —
// an investigator needs to know a sample was rejected and for what
// reason, not just see a gap in the data.

const { haversineMeters } = require("./routeDeviation");

const LIMITS = {
  maxPlausibleSpeedKmh: 180, // generous for Lagos expressways; well above anything legitimate
  maxFutureTimestampSeconds: 30, // allow small clock drift, not a device reporting from the future
  maxTelemetryAgeSeconds: 3600, // reject anything claiming to be over an hour old — almost certainly a clock issue, not real
};

/**
 * Validates one incoming telemetry sample against the previous accepted
 * sample for the same ride. Returns { valid: true } or
 * { valid: false, reason, classification } — never throws, since a
 * validation failure is expected, routine input, not an application
 * error.
 */
function validateTelemetry({ sample, previousSample, now = new Date() }) {
  const { lat, lng, recordedAt } = sample;

  if (typeof lat !== "number" || typeof lng !== "number" || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return { valid: false, reason: "Invalid coordinates", classification: "INVALID_COORDINATES" };
  }

  const recordedDate = new Date(recordedAt);
  if (isNaN(recordedDate.getTime())) {
    return { valid: false, reason: "Invalid timestamp", classification: "INVALID_TIMESTAMP" };
  }

  const secondsInFuture = (recordedDate - now) / 1000;
  if (secondsInFuture > LIMITS.maxFutureTimestampSeconds) {
    return { valid: false, reason: `Timestamp is ${secondsInFuture.toFixed(0)}s in the future`, classification: "TIMESTAMP_FUTURE" };
  }

  const ageSeconds = (now - recordedDate) / 1000;
  if (ageSeconds > LIMITS.maxTelemetryAgeSeconds) {
    return { valid: false, reason: `Timestamp is ${(ageSeconds / 60).toFixed(0)} minutes old`, classification: "TIMESTAMP_TOO_OLD" };
  }

  if (!previousSample) {
    return { valid: true };
  }

  const prevDate = new Date(previousSample.recordedAt);

  // Exact duplicate — same position, same timestamp as what we already
  // have. Checked BEFORE the out-of-order check below, since a duplicate
  // is technically also "not after" the previous sample and would
  // otherwise be misclassified as out-of-order instead of a duplicate.
  if (lat === previousSample.lat && lng === previousSample.lng && recordedDate.getTime() === prevDate.getTime()) {
    return { valid: false, reason: "Duplicate of previous sample", classification: "DUPLICATE" };
  }

  // Out-of-order: a sample claiming to be from before (or at the exact
  // same instant as, with a different position — physically impossible)
  // the last one we already accepted. Reject rather than silently
  // reordering — the deviation engine's persistence logic depends on
  // samples arriving in true chronological order.
  if (recordedDate <= prevDate) {
    return { valid: false, reason: "Timestamp is not after the previous accepted sample", classification: "OUT_OF_ORDER" };
  }

  const elapsedSeconds = (recordedDate - prevDate) / 1000;
  const distanceM = haversineMeters({ lat, lng }, { lat: previousSample.lat, lng: previousSample.lng });
  const impliedSpeedKmh = elapsedSeconds > 0 ? (distanceM / 1000) / (elapsedSeconds / 3600) : Infinity;

  if (impliedSpeedKmh > LIMITS.maxPlausibleSpeedKmh) {
    return {
      valid: false,
      reason: `Implied speed ${impliedSpeedKmh.toFixed(0)}km/h over ${elapsedSeconds.toFixed(0)}s is not physically plausible`,
      classification: "IMPOSSIBLE_JUMP",
    };
  }

  return { valid: true };
}

module.exports = { LIMITS, validateTelemetry };
