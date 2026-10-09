// Driver selfie check: before going online, a driver takes a fresh selfie while
// showing a challenge (a short code word written on paper, or a number of
// fingers). It stops a driver account being lent to someone else.
//
// HONEST LIMIT: with the default "manual" provider an admin compares the selfie
// with the profile photo by eye. There is no automatic face matching until a
// vendor (Smile ID, Prembly, etc.) is plugged in. decideFromScore() is the
// rule that vendor's score will go through, so adding one is a small change.
//
//  - The challenge is derived (HMAC of driver id and a 15 minute window), so a
//    photo taken earlier cannot be replayed: it shows an old challenge.
//  - A pending selfie counts as allowed for SELFIE_VALID_HOURS (default 24) so
//    drivers are not stuck waiting for review; a rejected one blocks until a new
//    one is submitted; admin can force a re-check at any time.
//  - Enforced only when the switch safety_selfie_required is on.

const crypto = require("crypto");
const { validateImageDataUrl } = require("./imageValidation");
const { logSafetyEvent } = require("./safetyEvents");

const WINDOW_MS = 15 * 60 * 1000;
const APPROVE_AT = 85;
const REJECT_BELOW = 50;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const WORDS = ["MANGO", "RIVER", "LAGOS", "TIGER", "PALM", "DRUM", "SUN", "KOLA", "BEAD", "CEDAR", "OKRA", "ZEBRA"];

class SelfieError extends Error {
  constructor(message, status = 400, code = "SELFIE_ERROR") {
    super(message);
    this.name = "SelfieError";
    this.status = status;
    this.code = code;
  }
}

function secret() {
  return process.env.SELFIE_SECRET || process.env.JWT_SECRET || "";
}

function validHours() {
  const v = Number(process.env.SELFIE_VALID_HOURS);
  return Number.isFinite(v) && v >= 1 && v <= 24 * 30 ? v : 24;
}

function getPool() {
  return require("../db/db").pool;
}

// Pure. The challenge shown for a driver in the 15 minute window containing `now`.
function challengeFor(driverId, now = new Date(), key = secret()) {
  if (!key) throw new Error("No secret available for selfie challenges (set SELFIE_SECRET or JWT_SECRET).");
  const w = Math.floor(new Date(now).getTime() / WINDOW_MS);
  const d = crypto.createHmac("sha256", key).update(`selfie:${driverId}:${w}`).digest();
  return `${WORDS[d[0] % WORDS.length]} ${String(d.readUInt16BE(1) % 100).padStart(2, "0")}`;
}

// Pure. Current and previous window both count, so a driver who started just
// before the window rolled over is not rejected.
function challengeAccepted(driverId, submitted, now = new Date(), key = secret()) {
  const prev = new Date(new Date(now).getTime() - WINDOW_MS);
  const s = String(submitted || "");
  return s === challengeFor(driverId, now, key) || s === challengeFor(driverId, prev, key);
}

// Pure. What a vendor score means.
function decideFromScore(score) {
  if (score === null || score === undefined || score === "") return "pending"; // Number(null) is 0, which would reject
  const n = Number(score);
  if (!Number.isFinite(n)) return "pending";
  if (n >= APPROVE_AT) return "approved";
  if (n < REJECT_BELOW) return "rejected";
  return "pending"; // in between goes to a human
}

// Pure. May this driver go online right now?
//   latest: newest selfie row or null; driver: { selfie_recheck_required }
function evaluate({ latest, driver, now = new Date(), required = true }) {
  if (!required) return { allowed: true, reason: "not_required" };
  if (driver && driver.selfie_recheck_required) {
    // A recheck is satisfied by a selfie submitted after the flag; the flag is
    // cleared when one is submitted, so a set flag always means "needed".
    return { allowed: false, reason: "recheck_required" };
  }
  if (!latest) return { allowed: false, reason: "none" };
  if (latest.status === "rejected") return { allowed: false, reason: "rejected" };
  const ageMs = new Date(now).getTime() - new Date(latest.created_at).getTime();
  if (ageMs > validHours() * 3600 * 1000) return { allowed: false, reason: "expired" };
  return { allowed: true, reason: latest.status };
}

async function latestFor(driverId, db) {
  const r = await (db || getPool()).query(
    "SELECT id, status, created_at, review_note FROM driver_selfie_checks WHERE driver_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1",
    [driverId]
  );
  return r.rows[0] || null;
}

async function isRequired() {
  return require("./systemConfig").getConfigBool("safety_selfie_required", false);
}

// Used by PATCH /api/drivers/status when going online.
async function checkGoOnline(driverId, { db, now = new Date() } = {}) {
  const pool = db || getPool();
  const required = await isRequired();
  if (!required) return { allowed: true, reason: "not_required" };
  const d = await pool.query("SELECT selfie_recheck_required FROM drivers WHERE id = $1", [driverId]);
  return evaluate({ latest: await latestFor(driverId, pool), driver: d.rows[0], now, required });
}

async function status(driverId, { db, now = new Date() } = {}) {
  const pool = db || getPool();
  const required = await isRequired();
  const d = await pool.query("SELECT selfie_recheck_required FROM drivers WHERE id = $1", [driverId]);
  const latest = await latestFor(driverId, pool);
  const verdict = evaluate({ latest, driver: d.rows[0], now, required: true });
  return {
    required,
    allowed: required ? verdict.allowed : true,
    reason: verdict.reason,
    latest: latest ? { status: latest.status, createdAt: latest.created_at, note: latest.review_note } : null,
    challenge: challengeFor(driverId, now),
    challengeValidMinutes: 15,
  };
}

async function submitSelfie(driverId, { imageDataUrl, challenge }, { db, now = new Date() } = {}) {
  const pool = db || getPool();
  if (!imageDataUrl) throw new SelfieError("A selfie photo is required.", 400, "IMAGE_REQUIRED");
  const bad = validateImageDataUrl(imageDataUrl, "Selfie", MAX_IMAGE_BYTES);
  if (bad) throw new SelfieError(bad, 400, "IMAGE_INVALID");
  if (!challengeAccepted(driverId, challenge, now)) {
    throw new SelfieError("That code has expired. Take the selfie again with the new code.", 400, "CHALLENGE_EXPIRED");
  }
  // Slow down spam: 6 per hour.
  const recent = await pool.query(
    "SELECT count(*)::int AS n FROM driver_selfie_checks WHERE driver_id = $1 AND created_at > now() - interval '1 hour'",
    [driverId]
  );
  if (recent.rows[0].n >= 6) throw new SelfieError("Too many tries. Please wait a little and try again.", 429, "TOO_MANY");

  const ins = await pool.query(
    `INSERT INTO driver_selfie_checks (driver_id, image_data_url, challenge, status, provider)
     VALUES ($1, $2, $3, 'pending', 'manual') RETURNING id, status, created_at`,
    [driverId, imageDataUrl, String(challenge)]
  );
  await pool.query("UPDATE drivers SET selfie_recheck_required = false WHERE id = $1", [driverId]);
  await logSafetyEvent(pool, "selfie_submitted", { driverId, detail: { selfieId: ins.rows[0].id } });
  return { id: ins.rows[0].id, status: "pending" };
}

// ---- admin ----

async function listPending({ db, limit = 50 } = {}) {
  const r = await (db || getPool()).query(
    `SELECT s.id, s.driver_id, s.image_data_url, s.challenge, s.created_at,
            u.name AS driver_name, d.profile_photo_url
       FROM driver_selfie_checks s
       JOIN drivers d ON d.id = s.driver_id
       JOIN users u ON u.id = d.user_id
      WHERE s.status = 'pending'
      ORDER BY s.created_at ASC LIMIT $1`,
    [Math.min(Math.max(Number(limit) || 50, 1), 200)]
  );
  return r.rows;
}

async function review(selfieId, adminUserId, { decision, note = "" }, { db } = {}) {
  const pool = db || getPool();
  if (!["approved", "rejected"].includes(decision)) throw new SelfieError("Decision must be approved or rejected.", 400, "BAD_DECISION");
  const cleanNote = String(note || "").trim();
  if (decision === "rejected" && cleanNote.length < 5) {
    throw new SelfieError("Say why it was rejected (at least 5 characters) so the driver knows what to fix.", 400, "NOTE_REQUIRED");
  }
  const r = await pool.query(
    `UPDATE driver_selfie_checks SET status = $2, reviewed_by = $3, review_note = $4, reviewed_at = now()
      WHERE id = $1 AND status = 'pending' RETURNING driver_id`,
    [selfieId, decision, adminUserId, cleanNote || null]
  );
  if (!r.rowCount) throw new SelfieError("That selfie was already reviewed or does not exist.", 409, "NOT_PENDING");
  await logSafetyEvent(pool, `selfie_${decision}`, { driverId: r.rows[0].driver_id, userId: adminUserId, detail: { selfieId, note: cleanNote } });
  return { id: selfieId, status: decision };
}

async function requireRecheck(driverId, adminUserId, { db } = {}) {
  const pool = db || getPool();
  const r = await pool.query("UPDATE drivers SET selfie_recheck_required = true, is_online = false WHERE id = $1 RETURNING id", [driverId]);
  if (!r.rowCount) throw new SelfieError("Driver not found.", 404, "NOT_FOUND");
  await logSafetyEvent(pool, "selfie_recheck_required", { driverId, userId: adminUserId });
  return { driverId, recheckRequired: true };
}

module.exports = {
  SelfieError, APPROVE_AT, REJECT_BELOW, challengeFor, challengeAccepted, decideFromScore, evaluate,
  checkGoOnline, status, submitSelfie, listPending, review, requireRecheck,
};
