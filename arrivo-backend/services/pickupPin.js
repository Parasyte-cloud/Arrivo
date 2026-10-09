// Pickup PIN: the rider shows a 4 digit PIN, the driver types it to start the
// trip. It proves the person getting in is the person who booked, and that the
// driver is with the right rider, before the meter runs.
//
//  - The PIN is derived (HMAC of ride id and nonce with a server secret), not
//    stored, so it cannot leak from the database and needs no extra column.
//  - 5 wrong tries lock the ride for 10 minutes, so it cannot be guessed
//    (10,000 possibilities would otherwise fall to a few minutes of tapping).
//  - Enforced only when safety_pickup_pin_required is on, and only for
//    ArrivoExpress rides. Support/admin can override with a written reason.

const crypto = require("crypto");
const { logSafetyEvent } = require("./safetyEvents");

const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 10;

class PinError extends Error {
  constructor(message, status = 400, code = "PIN_ERROR", extra = undefined) {
    super(message);
    this.name = "PinError";
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

function secret() {
  return process.env.PICKUP_PIN_SECRET || process.env.JWT_SECRET || "";
}

// Pure. The 4 digit PIN for a ride.
function derivePin(rideId, nonce = 0, key = secret()) {
  if (!key) throw new Error("No secret available to derive pickup PINs (set PICKUP_PIN_SECRET or JWT_SECRET).");
  const digest = crypto.createHmac("sha256", key).update(`pickup-pin:${rideId}:${nonce}`).digest();
  return String(digest.readUInt32BE(0) % 10000).padStart(4, "0");
}

// Pure. Constant-time comparison of what the driver typed.
function pinMatches(expected, typed) {
  const a = Buffer.from(String(expected));
  const b = Buffer.from(String(typed || "").trim());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function getPool() {
  return require("../db/db").pool;
}

async function isRequired(db) {
  return require("./systemConfig").getConfigBool("safety_pickup_pin_required", false);
}

async function isExpressRide(rideId, db) {
  const r = await (db || getPool()).query("SELECT 1 FROM instant_ride_requests WHERE ride_id = $1 LIMIT 1", [rideId]);
  return r.rowCount > 0;
}

async function ensureRow(db, rideId) {
  await db.query("INSERT INTO ride_pickup_pins (ride_id) VALUES ($1) ON CONFLICT DO NOTHING", [rideId]);
  return (await db.query("SELECT * FROM ride_pickup_pins WHERE ride_id = $1", [rideId])).rows[0];
}

// For the rider: the PIN to show. Only once a driver is assigned and before the
// trip has started, and only to the rider who booked.
async function getPinForRider(rideId, riderUserId, db) {
  const pool = db || getPool();
  const ride = (await pool.query("SELECT id, rider_id, driver_id, ride_status FROM rides WHERE id = $1", [rideId])).rows[0];
  if (!ride) throw new PinError("Ride not found.", 404, "NOT_FOUND");
  if (ride.rider_id !== riderUserId) throw new PinError("This is not your ride.", 403, "FORBIDDEN");
  const row = await ensureRow(pool, rideId);
  const verified = Boolean(row.verified_at);
  const show = ride.driver_id && ride.ride_status === "accepted" && !verified;
  return {
    required: await isRequired() && (await isExpressRide(rideId, pool)),
    verified,
    pin: show ? derivePin(rideId, row.nonce) : null,
  };
}

// For the driver: type the rider's PIN. Locks after too many wrong tries.
async function verifyPin(rideId, driverUserId, typedPin, db) {
  const pool = db || getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const ride = (await client.query(
      `SELECT r.id, r.ride_status, d.user_id AS driver_user_id, r.driver_id
         FROM rides r LEFT JOIN drivers d ON d.id = r.driver_id WHERE r.id = $1 FOR UPDATE OF r`,
      [rideId]
    )).rows[0];
    if (!ride) throw new PinError("Ride not found.", 404, "NOT_FOUND");
    if (ride.driver_user_id !== driverUserId) throw new PinError("This ride is not assigned to you.", 403, "FORBIDDEN");
    if (ride.ride_status !== "accepted") throw new PinError("The PIN is only needed before the trip starts.", 409, "NOT_AWAITING_PICKUP");

    const row = await ensureRow(client, rideId);
    await client.query("SELECT 1 FROM ride_pickup_pins WHERE ride_id = $1 FOR UPDATE", [rideId]);
    if (row.verified_at) { await client.query("COMMIT"); return { verified: true, alreadyVerified: true }; }

    if (row.locked_until && new Date(row.locked_until) > new Date()) {
      const retryAfterSeconds = Math.ceil((new Date(row.locked_until) - Date.now()) / 1000);
      throw new PinError("Too many wrong PINs. Try again in a few minutes, or ask the rider to contact support.", 429, "PIN_LOCKED", { retryAfterSeconds });
    }

    if (pinMatches(derivePin(rideId, row.nonce), typedPin)) {
      await client.query("UPDATE ride_pickup_pins SET verified_at = now(), failed_attempts = 0, locked_until = NULL WHERE ride_id = $1", [rideId]);
      await client.query("COMMIT");
      return { verified: true };
    }

    const attempts = row.failed_attempts + 1;
    const lock = attempts >= MAX_ATTEMPTS;
    await client.query(
      `UPDATE ride_pickup_pins SET failed_attempts = $2, locked_until = CASE WHEN $3 THEN now() + ($4 || ' minutes')::interval ELSE NULL END WHERE ride_id = $1`,
      [rideId, lock ? 0 : attempts, lock, String(LOCK_MINUTES)]
    );
    await client.query("COMMIT");
    if (lock) await logSafetyEvent(pool, "pin_locked", { rideId, userId: driverUserId, driverId: ride.driver_id });
    throw new PinError(
      lock ? "Too many wrong PINs. Try again in a few minutes, or ask the rider to contact support." : `That PIN is not right. ${MAX_ATTEMPTS - attempts} ${MAX_ATTEMPTS - attempts === 1 ? "try" : "tries"} left.`,
      lock ? 429 : 400,
      lock ? "PIN_LOCKED" : "PIN_WRONG",
      lock ? { retryAfterSeconds: LOCK_MINUTES * 60 } : { attemptsLeft: MAX_ATTEMPTS - attempts }
    );
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch (_) { /* already finished */ }
    throw error;
  } finally {
    client.release();
  }
}

// The gate used by the "start trip" route. Allowed when the feature is off,
// the ride is not an ArrivoExpress ride, or the PIN was verified (or overridden).
async function checkStartAllowed(rideId, db) {
  const pool = db || getPool();
  if (!(await isRequired())) return { allowed: true, required: false };
  if (!(await isExpressRide(rideId, pool))) return { allowed: true, required: false };
  const row = (await pool.query("SELECT verified_at FROM ride_pickup_pins WHERE ride_id = $1", [rideId])).rows[0];
  return { allowed: Boolean(row && row.verified_at), required: true };
}

// Staff override when the rider cannot show a PIN (phone died). Needs a reason, is audited.
async function override(rideId, adminUserId, note, db) {
  const pool = db || getPool();
  const text = String(note || "").trim();
  if (text.length < 10) throw new PinError("Write at least 10 characters saying why the PIN is being skipped.", 400, "NOTE_REQUIRED");
  const ride = (await pool.query("SELECT id, driver_id FROM rides WHERE id = $1", [rideId])).rows[0];
  if (!ride) throw new PinError("Ride not found.", 404, "NOT_FOUND");
  await ensureRow(pool, rideId);
  await pool.query("UPDATE ride_pickup_pins SET verified_at = now(), override_by = $2, override_note = $3 WHERE ride_id = $1", [rideId, adminUserId, text.slice(0, 300)]);
  await logSafetyEvent(pool, "pin_override", { rideId, userId: adminUserId, driverId: ride.driver_id, detail: { note: text.slice(0, 300) } });
  return { rideId, overridden: true };
}

module.exports = { PinError, MAX_ATTEMPTS, LOCK_MINUTES, derivePin, pinMatches, getPinForRider, verifyPin, checkStartAllowed, override, isExpressRide };
