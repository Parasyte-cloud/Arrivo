// Trip share links that expire.
//
// Before: one permanent token per ride, kept in plain text, that showed the
// driver's live location and phone number to anyone who ever got the link,
// forever. Now:
//  - Only a SHA-256 hash of the token is stored, so a database leak gives nobody
//    a working link.
//  - A link works until it expires (SHARE_LINK_MAX_HOURS, default 12, counted
//    from pickup time for a booked-ahead ride), until the rider revokes it, or
//    SHARE_LINK_GRACE_MINUTES (default 15) after the trip ends, whichever is first.
//  - Live location is shown only while the trip is active. Afterwards the link
//    says the trip has ended and shows nothing else.
//  - The driver's phone number is never shown on a link.
//  - Several links can exist (one per person you share with), at most 5 active
//    per ride, and the rider can stop sharing all of them in one tap.

const crypto = require("crypto");
const { logSafetyEvent } = require("./safetyEvents");

const MAX_ACTIVE_LINKS = 5;

class ShareError extends Error {
  constructor(message, status = 400, code = "SHARE_ERROR") {
    super(message);
    this.name = "ShareError";
    this.status = status;
    this.code = code;
  }
}

function maxHours() {
  const v = Number(process.env.SHARE_LINK_MAX_HOURS);
  return Number.isFinite(v) && v >= 1 && v <= 72 ? v : 12;
}
function graceMinutes() {
  const v = Number(process.env.SHARE_LINK_GRACE_MINUTES);
  return Number.isFinite(v) && v >= 0 && v <= 240 ? v : 15;
}

const hashToken = (token) => crypto.createHash("sha256").update(String(token)).digest("hex");
const newToken = () => crypto.randomBytes(24).toString("base64url");

const ACTIVE_STATUSES = ["accepted", "in_progress"];
const ENDED_STATUSES = ["completed", "cancelled"];

// Pure. Is this link usable right now?
//   link: { expires_at, revoked_at }   ride: { ride_status, completed_at, updated_at }
// Returns { ok, reason: 'revoked'|'expired'|'ended' }.
function linkState(link, ride, now = new Date(), grace = graceMinutes()) {
  if (link.revoked_at) return { ok: false, reason: "revoked" };
  if (new Date(link.expires_at) <= now) return { ok: false, reason: "expired" };
  if (ENDED_STATUSES.includes(ride.ride_status)) {
    const endedAt = new Date(ride.completed_at || ride.updated_at || now);
    if (now.getTime() - endedAt.getTime() > grace * 60000) return { ok: false, reason: "ended" };
  }
  return { ok: true };
}

// Pure. When a new link should stop working.
function expiryFor(ride, now = new Date(), hours = maxHours()) {
  const base = ride.scheduled_pickup_at && new Date(ride.scheduled_pickup_at) > now ? new Date(ride.scheduled_pickup_at) : now;
  return new Date(base.getTime() + hours * 3600000);
}

function getPool() {
  return require("../db/db").pool;
}

// Creates a new link for a ride the caller is part of. Returns the token ONCE.
async function createLink(rideId, user, db) {
  const pool = db || getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const ride = (await client.query("SELECT * FROM rides WHERE id = $1 FOR UPDATE", [rideId])).rows[0];
    if (!ride) throw new ShareError("Ride not found.", 404, "NOT_FOUND");
    const driver = (await client.query("SELECT id FROM drivers WHERE user_id = $1", [user.id])).rows[0];
    const isRider = ride.rider_id === user.id;
    const isDriver = driver && ride.driver_id === driver.id;
    if (!isRider && !isDriver && !["admin", "support"].includes(user.role)) throw new ShareError("You don't have access to this ride.", 403, "FORBIDDEN");
    if (ENDED_STATUSES.includes(ride.ride_status)) throw new ShareError("This trip has ended, so it can no longer be shared.", 409, "TRIP_ENDED");

    const active = await client.query(
      "SELECT id FROM ride_share_links WHERE ride_id = $1 AND revoked_at IS NULL AND expires_at > now() ORDER BY created_at ASC",
      [rideId]
    );
    // Over the cap: retire the oldest rather than refuse, so "Share" always works.
    for (const old of active.rows.slice(0, Math.max(active.rowCount - (MAX_ACTIVE_LINKS - 1), 0))) {
      await client.query("UPDATE ride_share_links SET revoked_at = now(), revoked_by = $2 WHERE id = $1", [old.id, user.id]);
    }

    const token = newToken();
    const expiresAt = expiryFor(ride);
    await client.query(
      "INSERT INTO ride_share_links (ride_id, token_hash, created_by, expires_at) VALUES ($1, $2, $3, $4)",
      [rideId, hashToken(token), user.id, expiresAt]
    );
    await client.query("COMMIT");
    return { token, expiresAt };
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch (_) { /* already finished */ }
    throw error;
  } finally {
    client.release();
  }
}

async function assertParticipant(rideId, user, db) {
  const pool = db || getPool();
  const ride = (await pool.query("SELECT * FROM rides WHERE id = $1", [rideId])).rows[0];
  if (!ride) throw new ShareError("Ride not found.", 404, "NOT_FOUND");
  const driver = (await pool.query("SELECT id FROM drivers WHERE user_id = $1", [user.id])).rows[0];
  if (ride.rider_id !== user.id && !(driver && ride.driver_id === driver.id) && !["admin", "support"].includes(user.role)) {
    throw new ShareError("You don't have access to this ride.", 403, "FORBIDDEN");
  }
  return ride;
}

// Stop sharing: every active link for the ride stops working immediately.
async function revokeAll(rideId, user, db) {
  const pool = db || getPool();
  await assertParticipant(rideId, user, pool);
  const r = await pool.query(
    "UPDATE ride_share_links SET revoked_at = now(), revoked_by = $2 WHERE ride_id = $1 AND revoked_at IS NULL RETURNING id",
    [rideId, user.id]
  );
  if (r.rowCount) await logSafetyEvent(pool, "share_revoked", { rideId, userId: user.id, detail: { links: r.rowCount } });
  return { revoked: r.rowCount };
}

// What the rider sees about their own links (never the tokens).
async function listActive(rideId, user, db) {
  const pool = db || getPool();
  await assertParticipant(rideId, user, pool);
  const r = await pool.query(
    `SELECT id, expires_at AS "expiresAt", view_count AS "viewCount", last_viewed_at AS "lastViewedAt", created_at AS "createdAt"
       FROM ride_share_links WHERE ride_id = $1 AND revoked_at IS NULL AND expires_at > now() ORDER BY created_at DESC`,
    [rideId]
  );
  return { links: r.rows };
}

const PUBLIC_COLUMNS = `rides.id, rides.pickup_address, rides.stops, rides.ride_status, rides.flight_number, rides.booking_type,
  rides.pickup_lat, rides.pickup_lng, rides.destination_lat, rides.destination_lng, rides.created_at,
  rides.completed_at, rides.updated_at,
  riders.name AS rider_name,
  driver_users.name AS driver_name,
  drivers.current_lat, drivers.current_lng, drivers.location_updated_at,
  drivers.profile_photo_url AS driver_photo_url, drivers.rating AS driver_rating,
  vehicles.make_model, vehicles.plate_number`;
const PUBLIC_FROM = `FROM rides
  JOIN users riders ON riders.id = rides.rider_id
  LEFT JOIN drivers ON drivers.id = rides.driver_id
  LEFT JOIN users driver_users ON driver_users.id = drivers.user_id
  LEFT JOIN vehicles ON vehicles.id = drivers.vehicle_id`;

// Pure. Trim a ride row to what a stranger with a link may see.
function publicView(row, now = new Date()) {
  const active = ACTIVE_STATUSES.includes(row.ride_status);
  const { completed_at, updated_at, ...ride } = row;
  if (!active) {
    // Trip over (or not started): status only. No position, no driver details.
    return {
      ride: { id: ride.id, ride_status: ride.ride_status, pickup_address: ride.pickup_address, created_at: ride.created_at },
      ended: ENDED_STATUSES.includes(ride.ride_status),
      live: false,
    };
  }
  return { ride, ended: false, live: true };
}

// Resolves a public token (new hashed links, and legacy rides.share_token
// links, which now obey the same end-of-trip rule). Returns { view } or
// { error: { status, message, reason } }.
async function resolvePublic(token, db) {
  const pool = db || getPool();
  const t = String(token || "");
  if (t.length < 16 || t.length > 200) return { error: { status: 404, reason: "invalid", message: "This tracking link is invalid or no longer active." } };

  const hash = hashToken(t);
  const found = await pool.query(
    `SELECT l.id AS link_id, l.expires_at, l.revoked_at, ${PUBLIC_COLUMNS} ${PUBLIC_FROM}
       JOIN ride_share_links l ON l.ride_id = rides.id WHERE l.token_hash = $1`,
    [hash]
  );
  if (found.rows[0]) {
    const row = found.rows[0];
    const state = linkState(row, row);
    if (!state.ok) return { error: { status: 410, reason: state.reason, message: state.reason === "revoked" ? "The rider stopped sharing this trip." : "This tracking link has expired." } };
    await pool.query("UPDATE ride_share_links SET view_count = view_count + 1, last_viewed_at = now() WHERE id = $1", [row.link_id]);
    const { link_id, expires_at, revoked_at, ...rideRow } = row;
    return { view: { ...publicView(rideRow), expiresAt: expires_at } };
  }

  // Legacy permanent token: still honoured, but only while the trip is on or just ended.
  const legacy = await pool.query(`SELECT ${PUBLIC_COLUMNS} ${PUBLIC_FROM} WHERE rides.share_token = $1`, [t]);
  if (legacy.rows[0]) {
    const row = legacy.rows[0];
    const state = linkState({ expires_at: new Date(Date.now() + 86400000), revoked_at: null }, row);
    if (!state.ok) return { error: { status: 410, reason: state.reason, message: "This tracking link has expired." } };
    return { view: publicView(row) };
  }
  return { error: { status: 404, reason: "invalid", message: "This tracking link is invalid or no longer active." } };
}

module.exports = { ShareError, MAX_ACTIVE_LINKS, hashToken, linkState, expiryFor, publicView, createLink, revokeAll, listActive, resolvePublic };
