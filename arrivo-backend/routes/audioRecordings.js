// In-trip audio recording ("listening device").
//
// Rider and driver apps record in short chunks and upload each one straight to
// private object storage with a presigned URL (services/audioStorage.js). This
// file only hands out those URLs, keeps the index, and lets admins listen.
//
// Everything is off unless RIDE_AUDIO_RECORDING_ENABLED=true AND a bucket is
// configured. Consent is required on every start and is stored with the row.
//
//   POST /api/recordings/start                   { rideId, consent: true, viaPanic? }
//   POST /api/recordings/:id/chunks              { seq, contentType, sizeBytes }  -> { uploadUrl }
//   POST /api/recordings/:id/chunks/:seq/complete { durationSec? }
//   POST /api/recordings/:id/finish
//   GET  /api/recordings/config
//
//   Admin only, Bearer token only (a shared browser cookie is refused):
//   GET  /api/admin/recordings?rideId=
//   POST /api/admin/recordings/:id/play-urls     (writes the access log first)
//   POST /api/admin/recordings/:id/hold          { hold: true|false }
//   GET  /api/admin/recordings/:id/access-log

const express = require("express");
const rateLimit = require("express-rate-limit");
const { pool } = require("../db/db");
const { requireAuth, requireRole } = require("../middleware/auth");
const storage = require("../services/audioStorage");

const router = express.Router();
const adminRouter = express.Router();

const MAX_CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_SEQ = 5000;
const MAX_RECORDINGS_PER_USER_PER_RIDE = 10;
const CONTENT_TYPES = {
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/m4a": "m4a",
  "audio/aac": "aac",
  "audio/mpeg": "mp3",
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
};

const perUserLimiter = (limit, message) =>
  rateLimit({
    windowMs: 10 * 60 * 1000,
    limit,
    keyGenerator: (req) => `u${req.user ? req.user.id : "anon"}`,
    validate: { keyGeneratorIpFallback: false },
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ error: message }),
  });
const startLimiter = perUserLimiter(30, "Too many recording starts. Please wait a few minutes.");
const chunkLimiter = perUserLimiter(600, "Too many uploads. Please wait a moment.");

function requireEnabled(req, res, next) {
  if (!storage.isEnabled()) {
    return res.status(503).json({ error: "Audio recording is not available yet." });
  }
  next();
}

function toInt(v) {
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

async function loadOwnOpenRecording(id, userId) {
  const r = await pool.query(
    `SELECT * FROM ride_audio_recordings WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
    [id, userId]
  );
  return r.rows[0] || null;
}

router.get("/config", requireAuth, (req, res) => {
  res.json({ enabled: storage.isEnabled(), retentionDays: storage.retentionDays(), chunkSeconds: 30 });
});

router.post("/start", requireAuth, requireEnabled, startLimiter, async (req, res) => {
  const { rideId, consent, viaPanic } = req.body || {};
  if (consent !== true) {
    return res.status(400).json({ error: "Recording needs your explicit consent." });
  }
  const rideIdInt = toInt(rideId);
  if (!rideIdInt || rideIdInt < 1) return res.status(400).json({ error: "rideId is required." });

  const ride = (
    await pool.query(
      `SELECT rides.id, rides.ride_status, rides.panic_triggered_at FROM rides
       LEFT JOIN drivers ON drivers.id = rides.driver_id
       WHERE rides.id = $1 AND (rides.rider_id = $2 OR drivers.user_id = $2)`,
      [rideIdInt, req.user.id]
    )
  ).rows[0];
  if (!ride) return res.status(404).json({ error: "Ride not found" });

  const live = ["accepted", "in_progress"].includes(ride.ride_status);
  if (!live && !ride.panic_triggered_at) {
    return res.status(409).json({ error: "Recording is only available during an active trip." });
  }

  // Starting again while one is open just returns it (a retry after a lost response).
  const open = (
    await pool.query(
      `SELECT * FROM ride_audio_recordings
       WHERE ride_id = $1 AND user_id = $2 AND ended_at IS NULL AND deleted_at IS NULL
       ORDER BY id DESC LIMIT 1`,
      [rideIdInt, req.user.id]
    )
  ).rows[0];
  if (open) return res.status(200).json({ recording: open, resumed: true });

  const count = await pool.query(
    "SELECT count(*)::int AS n FROM ride_audio_recordings WHERE ride_id = $1 AND user_id = $2",
    [rideIdInt, req.user.id]
  );
  if (count.rows[0].n >= MAX_RECORDINGS_PER_USER_PER_RIDE) {
    return res.status(429).json({ error: "Too many recordings for this trip." });
  }

  const hold = !!ride.panic_triggered_at;
  const created = await pool.query(
    `INSERT INTO ride_audio_recordings (ride_id, user_id, consent_at, started_via_panic, hold)
     VALUES ($1, $2, now(), $3, $4) RETURNING *`,
    [rideIdInt, req.user.id, viaPanic === true, hold]
  );
  // Same flag the old button set, so the admin dashboard keeps showing it.
  await pool.query(
    "UPDATE rides SET listening_device_activated_at = COALESCE(listening_device_activated_at, now()), updated_at = now() WHERE id = $1",
    [rideIdInt]
  );
  res.status(201).json({ recording: created.rows[0] });
});

router.post("/:id/chunks", requireAuth, requireEnabled, chunkLimiter, async (req, res) => {
  const id = toInt(req.params.id);
  const { seq, contentType, sizeBytes } = req.body || {};
  const seqInt = toInt(seq);
  const size = toInt(sizeBytes);
  if (!id || seqInt === null || seqInt < 0 || seqInt > MAX_SEQ) return res.status(400).json({ error: "seq is out of range." });
  const ext = typeof contentType === "string" ? CONTENT_TYPES[contentType.toLowerCase()] : null;
  if (!ext) return res.status(400).json({ error: "Unsupported audio type." });
  if (size === null || size < 1 || size > MAX_CHUNK_BYTES) return res.status(400).json({ error: "sizeBytes is out of range." });

  const recording = await loadOwnOpenRecording(id, req.user.id);
  if (!recording) return res.status(404).json({ error: "Recording not found" });
  if (recording.ended_at) return res.status(409).json({ error: "This recording has ended." });

  const existing = (await pool.query("SELECT * FROM ride_audio_chunks WHERE recording_id = $1 AND seq = $2", [id, seqInt])).rows[0];
  if (existing && existing.status === "uploaded") {
    return res.status(200).json({ alreadyUploaded: true });
  }
  const key = existing
    ? existing.object_key
    : `ride-audio/${recording.ride_id}/${recording.id}/${String(seqInt).padStart(5, "0")}.${ext}`;
  if (existing) {
    await pool.query("UPDATE ride_audio_chunks SET content_type = $1, declared_size_bytes = $2 WHERE id = $3", [contentType.toLowerCase(), size, existing.id]);
  } else {
    await pool.query(
      `INSERT INTO ride_audio_chunks (recording_id, seq, object_key, content_type, declared_size_bytes)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, seqInt, key, contentType.toLowerCase(), size]
    );
  }
  const uploadUrl = await storage.presignUpload(key, contentType.toLowerCase(), 600);
  res.json({ uploadUrl, expiresInSeconds: 600 });
});

router.post("/:id/chunks/:seq/complete", requireAuth, requireEnabled, chunkLimiter, async (req, res) => {
  const id = toInt(req.params.id);
  const seqInt = toInt(req.params.seq);
  if (!id || seqInt === null) return res.status(400).json({ error: "Bad request." });
  const recording = await loadOwnOpenRecording(id, req.user.id);
  if (!recording) return res.status(404).json({ error: "Recording not found" });
  const chunk = (await pool.query("SELECT * FROM ride_audio_chunks WHERE recording_id = $1 AND seq = $2", [id, seqInt])).rows[0];
  if (!chunk) return res.status(404).json({ error: "Chunk not found" });
  if (chunk.status === "uploaded") return res.json({ ok: true });

  const head = await storage.headObject(chunk.object_key);
  if (!head) return res.status(409).json({ error: "The upload has not arrived yet." });
  if (head.size > MAX_CHUNK_BYTES) {
    await storage.deleteObjects([chunk.object_key]);
    await pool.query("DELETE FROM ride_audio_chunks WHERE id = $1", [chunk.id]);
    return res.status(413).json({ error: "That chunk is too large." });
  }
  const dur = Number(req.body && req.body.durationSec);
  await pool.query(
    "UPDATE ride_audio_chunks SET status = 'uploaded', size_bytes = $1, duration_sec = $2, uploaded_at = now() WHERE id = $3",
    [head.size, Number.isFinite(dur) && dur >= 0 && dur < 3600 ? dur : null, chunk.id]
  );
  res.json({ ok: true });
});

router.post("/:id/finish", requireAuth, async (req, res) => {
  const id = toInt(req.params.id);
  if (!id) return res.status(400).json({ error: "Bad request." });
  const recording = await loadOwnOpenRecording(id, req.user.id);
  if (!recording) return res.status(404).json({ error: "Recording not found" });
  await pool.query("UPDATE ride_audio_recordings SET ended_at = COALESCE(ended_at, now()) WHERE id = $1", [id]);
  res.json({ ok: true });
});

// ── Admin ──

// Staff listen with a direct sign-in only. The shared single sign-on cookie is
// readable by every *.ridearrivo.com site we serve, so it must never be enough
// to hear a rider's audio.
function requireBearerOnly(req, res, next) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Listening to recordings needs a direct staff sign-in." });
  }
  next();
}
adminRouter.use(requireBearerOnly, requireAuth, requireRole("admin"));

adminRouter.get("/", async (req, res) => {
  const rideId = toInt(req.query.rideId);
  if (!rideId) return res.status(400).json({ error: "rideId is required." });
  const rows = await pool.query(
    `SELECT r.id, r.ride_id, r.user_id, u.name AS recorded_by, r.consent_at, r.started_via_panic, r.hold,
            r.ended_at, r.deleted_at, r.created_at,
            count(c.id) FILTER (WHERE c.status = 'uploaded')::int AS chunks_uploaded,
            COALESCE(sum(c.duration_sec) FILTER (WHERE c.status = 'uploaded'), 0)::float AS total_seconds
     FROM ride_audio_recordings r
     JOIN users u ON u.id = r.user_id
     LEFT JOIN ride_audio_chunks c ON c.recording_id = r.id
     WHERE r.ride_id = $1
     GROUP BY r.id, u.name
     ORDER BY r.id`,
    [rideId]
  );
  res.json({ recordings: rows.rows });
});

adminRouter.post("/:id/play-urls", async (req, res) => {
  const id = toInt(req.params.id);
  if (!id) return res.status(400).json({ error: "Bad request." });
  const rec = (await pool.query("SELECT * FROM ride_audio_recordings WHERE id = $1 AND deleted_at IS NULL", [id])).rows[0];
  if (!rec) return res.status(404).json({ error: "Recording not found" });
  // Log first: if this insert fails, no link is issued.
  await pool.query(
    "INSERT INTO ride_audio_access_log (recording_id, user_id, user_email, action, ip) VALUES ($1, $2, $3, 'play', $4)",
    [id, req.user.id, req.user.email, req.ip || null]
  );
  const chunks = (await pool.query(
    "SELECT seq, object_key, duration_sec FROM ride_audio_chunks WHERE recording_id = $1 AND status = 'uploaded' ORDER BY seq",
    [id]
  )).rows;
  const urls = [];
  for (const c of chunks) {
    urls.push({ seq: c.seq, durationSec: c.duration_sec === null ? null : Number(c.duration_sec), url: await storage.presignDownload(c.object_key, 600) });
  }
  res.json({ chunks: urls, expiresInSeconds: 600 });
});

adminRouter.post("/:id/hold", async (req, res) => {
  const id = toInt(req.params.id);
  const hold = req.body && req.body.hold;
  if (!id || typeof hold !== "boolean") return res.status(400).json({ error: "hold must be true or false." });
  const updated = await pool.query(
    "UPDATE ride_audio_recordings SET hold = $1 WHERE id = $2 AND deleted_at IS NULL RETURNING id, hold",
    [hold, id]
  );
  if (!updated.rows[0]) return res.status(404).json({ error: "Recording not found" });
  await pool.query(
    "INSERT INTO ride_audio_access_log (recording_id, user_id, user_email, action, ip) VALUES ($1, $2, $3, $4, $5)",
    [id, req.user.id, req.user.email, hold ? "hold" : "release", req.ip || null]
  );
  res.json({ ok: true, hold });
});

adminRouter.get("/:id/access-log", async (req, res) => {
  const id = toInt(req.params.id);
  if (!id) return res.status(400).json({ error: "Bad request." });
  const rows = await pool.query(
    "SELECT user_email, action, ip, created_at FROM ride_audio_access_log WHERE recording_id = $1 ORDER BY id DESC LIMIT 200",
    [id]
  );
  res.json({ log: rows.rows });
});

module.exports = router;
module.exports.adminRouter = adminRouter;
