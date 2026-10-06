const crypto = require("crypto");

// Ride-booking idempotency -- see db/schema.sql's ride_idempotency_keys
// table for the full reasoning. This module exists because wallet,
// family_wallet, and membership bookings debit money (or spend a
// membership trip) and insert the ride in ONE request, with no separate
// confirm step the way card payments have. If the response to that request
// is lost, the rider retries, and without this, the retry ran the whole
// debit-and-insert a second time.
//
// Usage (see routes/rides.js): call beginIdempotentRide INSIDE an
// already-open transaction, before any money moves or any row is written.
//   * If it returns { claimed: true }, this is a genuinely new attempt --
//     do the real work, then call completeIdempotentRide with the outcome
//     BEFORE committing, then COMMIT.
//   * If it returns { claimed: false, replay: true, ... }, an identical
//     request already completed -- ROLLBACK (nothing was written this time)
//     and send back the stored response instead of doing the work again.
//   * If it returns { claimed: false, conflict: true }, the same key was
//     reused for a materially different booking -- ROLLBACK and respond 409.
//
// Relies entirely on the UNIQUE (user_id, idempotency_key) index plus
// ordinary transaction semantics for its safety, not on any lock this module
// takes explicitly:
//   * Two concurrent requests with the same key: Postgres blocks the second
//     INSERT on the first's uncommitted row until the first transaction
//     commits or rolls back, so they can never both "win" -- see the
//     schema.sql comment for the full argument.
//   * A retry after a genuine failure: the failed transaction rolled back,
//     which undoes its idempotency-row insert along with everything else,
//     so the key is simply free again.

function normalizeForHash(value) {
  if (Array.isArray(value)) return value.map(normalizeForHash);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = normalizeForHash(value[key]);
    return out;
  }
  // Treat undefined/null/"" as equivalent so an omitted optional field
  // doesn't make an otherwise-identical retry look like a different booking.
  if (value === undefined || value === null) return null;
  return value;
}

// Hashes only the fields that determine what's actually being booked and
// charged -- not the whole request body, which can legitimately vary
// between an original attempt and its retry in ways that don't matter (for
// instance the client re-sending a slightly different distanceKm/durationMin
// estimate from a fresh geolocation fix). If a field that DOES change the
// booking or the charge is added to POST /api/rides later, add it here too.
const HASHED_FIELDS = [
  "pickupAddress", "stops", "flightNumber", "vehicleType", "bookingType",
  "durationDays", "securityEscort", "fleetSize", "luxury", "payAtPickup",
  "paymentMethod", "familyMemberUserId", "partnerVenueId", "adults", "children",
  "hoursPerDay", "scheduledPickupAt", "linkedRideId",
];

function hashBookingRequest(body) {
  const picked = {};
  for (const field of HASHED_FIELDS) picked[field] = normalizeForHash(body[field]);
  const canonical = JSON.stringify(picked);
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

// Must be called inside an already-open transaction on dbClient (BEGIN
// already issued). userId/idempotencyKey identify the attempt;
// requestBody is the raw req.body, hashed internally via
// hashBookingRequest so callers never have to remember which fields matter.
async function beginIdempotentRide(dbClient, userId, idempotencyKey, requestBody) {
  const requestHash = hashBookingRequest(requestBody);

  const inserted = await dbClient.query(
    `INSERT INTO ride_idempotency_keys (user_id, idempotency_key, request_hash, status)
     VALUES ($1, $2, $3, 'pending')
     ON CONFLICT (user_id, idempotency_key) DO NOTHING
     RETURNING id`,
    [userId, idempotencyKey, requestHash]
  );
  if (inserted.rows[0]) {
    return { claimed: true, recordId: inserted.rows[0].id };
  }

  // Lost the race (or this key was already used, possibly long ago). By the
  // time our blocked INSERT above resolved, whichever transaction holds -- or
  // held -- this key has either committed (so its row is visible with
  // status/response filled in) or rolled back (in which case our own INSERT
  // would not have conflicted at all, so we would not be here). So this read
  // is always of a completed, committed attempt, never a half-finished one.
  const existing = await dbClient.query(
    `SELECT id, request_hash, status, ride_id, response_status, response_body
     FROM ride_idempotency_keys WHERE user_id = $1 AND idempotency_key = $2`,
    [userId, idempotencyKey]
  );
  const row = existing.rows[0];
  if (!row || row.status !== "completed") {
    // Should not happen in practice (see comment above) -- fail closed
    // rather than risk a double-charge by proceeding as if new.
    return { claimed: false, conflict: true, reason: "idempotency_key_in_progress" };
  }
  if (row.request_hash !== requestHash) {
    return { claimed: false, conflict: true, reason: "idempotency_key_reused_for_different_booking" };
  }
  return { claimed: false, replay: true, responseStatus: row.response_status, responseBody: row.response_body };
}

// Call once the real booking work has succeeded, BEFORE committing the same
// transaction beginIdempotentRide's INSERT is part of, so the claim and the
// outcome it's recording always commit (or roll back) together.
async function completeIdempotentRide(dbClient, recordId, { rideId, responseStatus, responseBody }) {
  await dbClient.query(
    `UPDATE ride_idempotency_keys
     SET status = 'completed', ride_id = $2, response_status = $3, response_body = $4, updated_at = now()
     WHERE id = $1`,
    [recordId, rideId, responseStatus, JSON.stringify(responseBody)]
  );
}

module.exports = { beginIdempotentRide, completeIdempotentRide, hashBookingRequest };
