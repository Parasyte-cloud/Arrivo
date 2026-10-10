// In-trip audio recording, against a real Postgres and the real routers.
// Object storage is replaced with an in-memory fake; nothing leaves the machine.
//   DATABASE_URL=postgres://localhost/... node routes/audioRecordings.integration.test.js

const assert = require("assert");
const http = require("http");
const jwt = require("jsonwebtoken");

process.env.JWT_SECRET = process.env.JWT_SECRET || "integration-test-secret";
process.env.RIDE_AUDIO_RECORDING_ENABLED = "true";

const express = require("express");
require("express-async-errors");
const { pool } = require("../db/db");
const storage = require("../services/audioStorage");
const { purgeExpiredRecordings } = require("../services/audioRetention");
const audio = require("./audioRecordings");

const objects = new Map(); // key -> size
const deleted = [];
storage.setStorageForTests({
  presignUpload: async (key) => `https://fake-r2.test/upload/${key}?sig=1`,
  presignDownload: async (key) => `https://fake-r2.test/get/${key}?sig=1`,
  headObject: async (key) => (objects.has(key) ? { size: objects.get(key) } : null),
  deleteObjects: async (keys) => { keys.forEach((k) => { deleted.push(k); objects.delete(k); }); },
});

const app = express();
app.use(express.json());
app.use("/api/admin/recordings", audio.adminRouter);
app.use("/api/recordings", audio);
app.use("/api/rides", require("./rides"));
app.use((err, req, res, next) => res.status(500).json({ error: "server error", detail: err.message }));
const server = http.createServer(app);

let passed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.log(`FAIL  ${name}`); console.log(`      ${e.stack || e.message}`); process.exitCode = 1; }
}
async function call(path, { method = "GET", token, body, headers = {} } = {}) {
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const stamp = Date.now();
const userIds = [];
async function makeUser(tag, role = "rider") {
  const email = `aud-${tag}-${stamp}@example.com`;
  const row = (await pool.query(
    `INSERT INTO users (name, email, password_hash, role, agreed_to_terms, email_verified) VALUES ($1,$2,'x',$3,true,true) RETURNING id, token_version`,
    [`Aud ${tag}`, email, role])).rows[0];
  userIds.push(row.id);
  const token = jwt.sign({ id: row.id, email, role, tv: row.token_version }, process.env.JWT_SECRET, { expiresIn: "1h" });
  return { id: row.id, email, token };
}
async function makeRide(riderId, status = "in_progress", driverUserId = null) {
  let driverId = null;
  if (driverUserId) {
    driverId = (await pool.query("INSERT INTO drivers (user_id, is_verified) VALUES ($1, true) RETURNING id", [driverUserId])).rows[0].id;
  }
  return (await pool.query(
    `INSERT INTO rides (rider_id, driver_id, pickup_address, stops, vehicle_type, fare_naira, ride_status, booking_type, agreed_cancellation_policy)
     VALUES ($1,$2,'Airport','[]','sedan',1000,$3,'one_way',true) RETURNING id`, [riderId, driverId, status])).rows[0].id;
}

(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const rider = await makeUser("rider");
  const driverUser = await makeUser("driver", "driver");
  const stranger = await makeUser("stranger");
  const admin = await makeUser("admin", "admin");
  const support = await makeUser("support", "support");
  const rideId = await makeRide(rider.id, "in_progress", driverUser.id);

  console.log("Starting a recording:");
  await test("consent is required", async () => {
    const r = await call("/api/recordings/start", { method: "POST", token: rider.token, body: { rideId } });
    assert.strictEqual(r.status, 400, JSON.stringify(r.body));
  });
  await test("someone who is not on the ride cannot record it", async () => {
    const r = await call("/api/recordings/start", { method: "POST", token: stranger.token, body: { rideId, consent: true } });
    assert.strictEqual(r.status, 404);
  });
  await test("a finished trip cannot be recorded", async () => {
    const done = await makeRide(rider.id, "completed");
    const r = await call("/api/recordings/start", { method: "POST", token: rider.token, body: { rideId: done, consent: true } });
    assert.strictEqual(r.status, 409);
  });
  let rec;
  await test("rider starts; a retry returns the same recording", async () => {
    const a = await call("/api/recordings/start", { method: "POST", token: rider.token, body: { rideId, consent: true } });
    assert.strictEqual(a.status, 201, JSON.stringify(a.body));
    rec = a.body.recording;
    const b = await call("/api/recordings/start", { method: "POST", token: rider.token, body: { rideId, consent: true } });
    assert.strictEqual(b.status, 200);
    assert.strictEqual(b.body.recording.id, rec.id);
    const flag = await pool.query("SELECT listening_device_activated_at FROM rides WHERE id = $1", [rideId]);
    assert.ok(flag.rows[0].listening_device_activated_at);
  });
  await test("the driver can also record the same ride", async () => {
    const r = await call("/api/recordings/start", { method: "POST", token: driverUser.token, body: { rideId, consent: true } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  });
  await test("switched off, nothing starts", async () => {
    process.env.RIDE_AUDIO_RECORDING_ENABLED = "false";
    try {
      const r = await call("/api/recordings/start", { method: "POST", token: rider.token, body: { rideId, consent: true } });
      assert.strictEqual(r.status, 503);
      const c = await call("/api/recordings/config", { token: rider.token });
      assert.strictEqual(c.body.enabled, false);
    } finally { process.env.RIDE_AUDIO_RECORDING_ENABLED = "true"; }
  });

  console.log("Uploading chunks:");
  await test("a chunk upload link is issued and the upload is confirmed", async () => {
    const r = await call(`/api/recordings/${rec.id}/chunks`, { method: "POST", token: rider.token, body: { seq: 0, contentType: "audio/mp4", sizeBytes: 5000 } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.uploadUrl.startsWith("https://fake-r2.test/upload/ride-audio/"));
    const early = await call(`/api/recordings/${rec.id}/chunks/0/complete`, { method: "POST", token: rider.token, body: { durationSec: 30 } });
    assert.strictEqual(early.status, 409, "confirming before the upload arrives must fail");
    const key = (await pool.query("SELECT object_key FROM ride_audio_chunks WHERE recording_id = $1 AND seq = 0", [rec.id])).rows[0].object_key;
    objects.set(key, 5000);
    const done = await call(`/api/recordings/${rec.id}/chunks/0/complete`, { method: "POST", token: rider.token, body: { durationSec: 30 } });
    assert.strictEqual(done.status, 200, JSON.stringify(done.body));
    const again = await call(`/api/recordings/${rec.id}/chunks`, { method: "POST", token: rider.token, body: { seq: 0, contentType: "audio/mp4", sizeBytes: 5000 } });
    assert.strictEqual(again.body.alreadyUploaded, true);
  });
  await test("bad type, size and sequence are refused", async () => {
    const bad = [
      { seq: 1, contentType: "text/html", sizeBytes: 100 },
      { seq: 1, contentType: "audio/mp4", sizeBytes: 0 },
      { seq: 1, contentType: "audio/mp4", sizeBytes: 9 * 1024 * 1024 },
      { seq: -1, contentType: "audio/mp4", sizeBytes: 100 },
      { seq: 99999, contentType: "audio/mp4", sizeBytes: 100 },
    ];
    for (const body of bad) {
      const r = await call(`/api/recordings/${rec.id}/chunks`, { method: "POST", token: rider.token, body });
      assert.strictEqual(r.status, 400, JSON.stringify(body));
    }
  });
  await test("only the person who started a recording can add to it", async () => {
    const r = await call(`/api/recordings/${rec.id}/chunks`, { method: "POST", token: driverUser.token, body: { seq: 2, contentType: "audio/mp4", sizeBytes: 100 } });
    assert.strictEqual(r.status, 404);
  });
  await test("a finished recording accepts no more chunks", async () => {
    const f = await call(`/api/recordings/${rec.id}/finish`, { method: "POST", token: rider.token });
    assert.strictEqual(f.status, 200);
    const r = await call(`/api/recordings/${rec.id}/chunks`, { method: "POST", token: rider.token, body: { seq: 3, contentType: "audio/mp4", sizeBytes: 100 } });
    assert.strictEqual(r.status, 409);
  });

  console.log("Staff listening:");
  await test("riders and support staff cannot list or play recordings", async () => {
    for (const t of [rider.token, support.token, stranger.token]) {
      const l = await call(`/api/admin/recordings?rideId=${rideId}`, { token: t });
      assert.ok(l.status === 403, `list ${l.status}`);
      const p = await call(`/api/admin/recordings/${rec.id}/play-urls`, { method: "POST", token: t });
      assert.ok(p.status === 403, `play ${p.status}`);
    }
  });
  await test("a browser cookie alone is never enough, even for an admin", async () => {
    const r = await call(`/api/admin/recordings?rideId=${rideId}`, { headers: { Cookie: `arrivo_session=${admin.token}` } });
    assert.strictEqual(r.status, 401, JSON.stringify(r.body));
  });
  await test("an admin lists, plays (logged) and sees the log", async () => {
    const l = await call(`/api/admin/recordings?rideId=${rideId}`, { token: admin.token });
    assert.strictEqual(l.status, 200, JSON.stringify(l.body));
    const mine = l.body.recordings.find((x) => x.id === rec.id);
    assert.strictEqual(mine.chunks_uploaded, 1);
    const p = await call(`/api/admin/recordings/${rec.id}/play-urls`, { method: "POST", token: admin.token });
    assert.strictEqual(p.status, 200, JSON.stringify(p.body));
    assert.strictEqual(p.body.chunks.length, 1);
    assert.ok(p.body.chunks[0].url.startsWith("https://fake-r2.test/get/"));
    const log = await call(`/api/admin/recordings/${rec.id}/access-log`, { token: admin.token });
    assert.strictEqual(log.body.log[0].action, "play");
    assert.strictEqual(log.body.log[0].user_email, admin.email);
  });

  console.log("Retention and holds:");
  await test("expired recordings are deleted; held and fresh ones are kept", async () => {
    async function seed(ageDays, hold) {
      const r = (await pool.query(
        `INSERT INTO ride_audio_recordings (ride_id, user_id, consent_at, hold, created_at) VALUES ($1,$2,now(),$3, now() - ($4 || ' days')::interval) RETURNING id`,
        [rideId, rider.id, hold, String(ageDays)])).rows[0].id;
      const key = `ride-audio/test/${r}/00000.m4a`;
      await pool.query(`INSERT INTO ride_audio_chunks (recording_id, seq, object_key, content_type, declared_size_bytes, status) VALUES ($1,0,$2,'audio/mp4',10,'uploaded')`, [r, key]);
      objects.set(key, 10);
      return { id: r, key };
    }
    const old = await seed(45, false);
    const oldHeld = await seed(45, true);
    const fresh = await seed(2, false);
    await purgeExpiredRecordings();
    const state = async (id) => (await pool.query("SELECT deleted_at FROM ride_audio_recordings WHERE id = $1", [id])).rows[0].deleted_at;
    assert.ok(await state(old.id), "old one should be deleted");
    assert.ok(deleted.includes(old.key));
    assert.strictEqual(await state(oldHeld.id), null);
    assert.strictEqual(await state(fresh.id), null);
    assert.ok(objects.has(oldHeld.key) && objects.has(fresh.key));
  });
  await test("a panic alert puts existing recordings on hold; an admin can release", async () => {
    const r = await call(`/api/rides/${rideId}/panic`, { method: "POST", token: rider.token, body: { note: "test" } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    await new Promise((x) => setTimeout(x, 200));
    const held = await pool.query("SELECT hold FROM ride_audio_recordings WHERE id = $1", [rec.id]);
    assert.strictEqual(held.rows[0].hold, true);
    const rel = await call(`/api/admin/recordings/${rec.id}/hold`, { method: "POST", token: admin.token, body: { hold: false } });
    assert.strictEqual(rel.status, 200);
    const again = await pool.query("SELECT hold FROM ride_audio_recordings WHERE id = $1", [rec.id]);
    assert.strictEqual(again.rows[0].hold, false);
  });
  await test("a recording started after a panic is held from the start", async () => {
    const r2 = await makeRide(rider.id, "completed");
    await pool.query("UPDATE rides SET panic_triggered_at = now() WHERE id = $1", [r2]);
    const s = await call("/api/recordings/start", { method: "POST", token: rider.token, body: { rideId: r2, consent: true, viaPanic: true } });
    assert.strictEqual(s.status, 201, JSON.stringify(s.body));
    assert.strictEqual(s.body.recording.hold, true);
  });

  for (const id of userIds) {
    await pool.query("DELETE FROM ride_audio_recordings WHERE user_id = $1", [id]).catch(() => {});
    await pool.query("DELETE FROM rides WHERE rider_id = $1", [id]).catch(() => {});
    await pool.query("DELETE FROM drivers WHERE user_id = $1", [id]).catch(() => {});
    await pool.query("DELETE FROM users WHERE id = $1", [id]).catch(() => {});
  }
  server.close();
  await pool.end();
  console.log(`\n${passed} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
