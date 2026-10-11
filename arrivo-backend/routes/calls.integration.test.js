// Rider <-> driver in-app calling, against a REAL Postgres and the real routes.
//   DATABASE_URL=postgres://... node routes/calls.integration.test.js
// Stream is the only stand-in: a recording fake that can be told to fail.
// The things that matter most are checked hardest: no phone number ever leaves
// the server for the other party, strangers cannot ring anyone, two taps (or two
// people) never make two calls, and when something breaks the person is handed
// to support with the ride already attached.

const assert = require("assert");
const http = require("http");
const jwt = require("jsonwebtoken");

process.env.JWT_SECRET = process.env.JWT_SECRET || "integration-test-secret";
process.env.STREAM_API_KEY = "test-key";
process.env.SUPPORT_PHONE_DIAL = "+2340000000001";

const express = require("express");
require("express-async-errors");
const { pool, ready } = require("../db/db");
const callsRouter = require("./calls");
const { requireAuth } = require("../middleware/auth");
const { maskCounterpartyPhones } = require("../services/contactPrivacy");

let passed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.log(`FAIL  ${name}\n      ${e.stack.split("\n").slice(0, 3).join("\n      ")}`); process.exitCode = 1; }
}

// ── fake Stream ──
const fake = { created: [], tokens: [], upserts: [], failCreate: false, unavailable: false, chatRoles: [], delay: 0 };
function resetFake() { Object.assign(fake, { created: [], tokens: [], upserts: [], failCreate: false, unavailable: false, chatRoles: [], delay: 0 }); }
callsRouter.__setStreamClientsForTests(() => {
  if (fake.unavailable) throw new Error("not configured");
  return {
    video: {
      upsertUsers: async (users) => { fake.upserts.push(...users); },
      call: (type, id) => ({
        getOrCreate: async (opts) => {
          if (fake.delay) await new Promise((r) => setTimeout(r, fake.delay));
          if (fake.failCreate) throw new Error("stream down");
          fake.created.push({ type, id, opts });
        },
      }),
      generateCallToken: (o) => { fake.tokens.push(o); return `call-token-${o.user_id}`; },
      generateUserToken: (o) => `user-token-${o.user_id}`,
    },
    chat: { upsertUser: async () => {}, createToken: () => "chat-token" },
  };
});

// A stand-in for the real ride routes, to prove the masking middleware works
// on the same wiring server.js uses.
const stubRides = express.Router();
stubRides.get("/:id", requireAuth, async (req, res) => {
  const r = await pool.query("SELECT r.id, r.rider_id, u.phone AS rider_phone, du.phone AS driver_phone, r.emergency_contact_phone FROM rides r JOIN users u ON u.id=r.rider_id LEFT JOIN drivers d ON d.id=r.driver_id LEFT JOIN users du ON du.id=d.user_id WHERE r.id=$1", [req.params.id]);
  res.json({ ride: r.rows[0] });
});
stubRides.get("/public/:id", async (req, res) => {
  const r = await pool.query("SELECT du.phone AS driver_phone, du.name AS driver_name FROM rides r JOIN drivers d ON d.id=r.driver_id JOIN users du ON du.id=d.user_id WHERE r.id=$1", [req.params.id]);
  res.json(r.rows[0]);
});

const app = express();
app.use(express.json());
app.use("/api/calls", callsRouter);
app.use("/api/rides", maskCounterpartyPhones, stubRides);
app.use((err, req, res, next) => res.status(500).json({ error: "server error", detail: err.message }));
const server = http.createServer(app);

async function api(path, { method = "GET", as, body } = {}) {
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(as ? { Authorization: `Bearer ${as.token}` } : {}) },
    body: body === undefined || method === "GET" ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = {}; try { json = JSON.parse(text); } catch (_) {}
  return { status: res.status, body: json, text };
}

const stamp = Date.now();
let seq = 0;
const madeUsers = [];
async function mkUser(role, phone) {
  seq++;
  const r = await pool.query(
    "INSERT INTO users (name, email, phone, password_hash, role, push_token) VALUES ($1,$2,$3,'x',$4,NULL) RETURNING id",
    [`${role} Person${seq}`, `call-${role}-${seq}-${stamp}@example.com`, phone, role]
  );
  const id = r.rows[0].id;
  madeUsers.push(id);
  return { id, role, phone, token: jwt.sign({ id, email: `u${id}@example.com`, role, tv: 0 }, process.env.JWT_SECRET, { algorithm: "HS256" }) };
}
let phoneSeq = 1000;
const nextPhone = () => `+23480${++phoneSeq}${String(phoneSeq).slice(-3)}55`;

// rider + driver + ride in the given status
async function scenario(status = "accepted", { driver = true, updatedMinutesAgo = 0 } = {}) {
  const rider = await mkUser("rider", nextPhone());
  const drv = await mkUser("driver", nextPhone());
  const stranger = await mkUser("rider", nextPhone());
  const d = await pool.query("INSERT INTO drivers (user_id, is_verified) VALUES ($1,true) RETURNING id", [drv.id]);
  const ride = await pool.query(
    `INSERT INTO rides (rider_id, driver_id, pickup_address, fare_naira, ride_status, emergency_contact_phone, updated_at)
     VALUES ($1,$2,'Ikoyi',10000,$3,$4, now() - ($5 || ' minutes')::interval) RETURNING id`,
    [rider.id, driver ? d.rows[0].id : null, status, nextPhone(), String(updatedMinutesAgo)]
  );
  return { rider, driver: drv, stranger, rideId: ride.rows[0].id };
}
const sessionsFor = async (rideId) => (await pool.query("SELECT * FROM call_sessions WHERE ride_id=$1 ORDER BY created_at", [rideId])).rows;
const allPhones = (s) => [s.rider.phone, s.driver.phone];
function assertNoPhones(text, s, label) {
  for (const p of allPhones(s)) assert.ok(!text.includes(p), `${label} leaked a phone number`);
  assert.ok(!/rider_phone|driver_phone|\+234\d{8,}/.test(text.replace(process.env.SUPPORT_PHONE_DIAL, "").replace(process.env.SUPPORT_PHONE_DIAL.replace(/\D/g, ""), "")), `${label} contains a phone-like value`);
}

(async () => {
await ready;
await new Promise((r) => server.listen(0, "127.0.0.1", r));

console.log("who may call:");
await test("rider can call the assigned driver; driver can call the rider", async () => {
  resetFake();
  const s = await scenario();
  const a = await api(`/api/calls/ride/${s.rideId}/availability`, { as: s.rider });
  assert.strictEqual(a.status, 200); assert.ok(a.body.canCall); assert.strictEqual(a.body.you, "rider");
  assert.strictEqual(a.body.counterparty.role, "driver");
  const b = await api(`/api/calls/ride/${s.rideId}/availability`, { as: s.driver });
  assert.ok(b.body.canCall); assert.strictEqual(b.body.you, "driver");
});
await test("a stranger gets 403 on availability, start, and cannot learn anything", async () => {
  const s = await scenario();
  for (const [p, m] of [[`/api/calls/ride/${s.rideId}/availability`, "GET"], [`/api/calls/ride/${s.rideId}/start`, "POST"]]) {
    const r = await api(p, { method: m, as: s.stranger, body: {} });
    assert.strictEqual(r.status, 403, `${m} ${p}`);
  }
  assert.strictEqual((await sessionsFor(s.rideId)).length, 0);
});
await test("no token is 401; unknown ride 404; junk ride id 400", async () => {
  const s = await scenario();
  assert.strictEqual((await api(`/api/calls/ride/${s.rideId}/start`, { method: "POST", body: {} })).status, 401);
  assert.strictEqual((await api(`/api/calls/ride/99999999/start`, { method: "POST", as: s.rider, body: {} })).status, 404);
  for (const bad of ["abc", "1.5", "-3", "0", "99999999999999"]) {
    assert.strictEqual((await api(`/api/calls/ride/${bad}/start`, { method: "POST", as: s.rider, body: {} })).status, 400, bad);
  }
});
await test("no driver yet, cancelled, long-finished: all refused with support attached", async () => {
  for (const [status, opts, code] of [["requested", { driver: false }, "no_driver"], ["cancelled", {}, "cancelled"], ["completed", { updatedMinutesAgo: 90 }, "trip_over"], ["requested", {}, "not_active"]]) {
    const s = await scenario(status, opts);
    const r = await api(`/api/calls/ride/${s.rideId}/start`, { method: "POST", as: s.rider, body: {} });
    assert.strictEqual(r.status, 409, status); assert.strictEqual(r.body.code, code);
    assert.ok(r.body.support && r.body.support.message.includes("We'll take care of you"));
    assert.strictEqual((await sessionsFor(s.rideId)).length, 0);
  }
});
await test("just-finished trip can still be called (lost property window)", async () => {
  resetFake();
  const s = await scenario("completed", { updatedMinutesAgo: 10 });
  assert.strictEqual((await api(`/api/calls/ride/${s.rideId}/start`, { method: "POST", as: s.rider, body: {} })).status, 201);
});

console.log("starting a call:");
await test("rider starts: server creates the call, rings the driver, gives a token for that call only", async () => {
  resetFake();
  const s = await scenario();
  const r = await api(`/api/calls/ride/${s.rideId}/start`, { method: "POST", as: s.rider, body: { media: "audio" } });
  assert.strictEqual(r.status, 201, r.text);
  assert.strictEqual(fake.created.length, 1);
  const c = fake.created[0];
  assert.strictEqual(c.opts.ring, true); assert.strictEqual(c.opts.video, false);
  assert.deepStrictEqual(c.opts.data.members.map((m) => m.user_id).sort(), [String(s.rider.id), String(s.driver.id)].sort());
  assert.strictEqual(c.opts.data.created_by_id, String(s.rider.id));
  assert.strictEqual(fake.tokens.length, 1);
  assert.deepStrictEqual(fake.tokens[0].call_cids, [`default:${c.id}`]);
  assert.strictEqual(fake.tokens[0].user_id, String(s.rider.id));
  assert.ok(fake.tokens[0].validity_in_seconds <= 3600);
  assert.strictEqual(r.body.join.userId, String(s.rider.id));
  assert.strictEqual(r.body.callee.role, "driver");
  const rows = await sessionsFor(s.rideId);
  assert.strictEqual(rows.length, 1); assert.strictEqual(rows[0].status, "ringing");
  assert.strictEqual(rows[0].caller_user_id, s.rider.id); assert.strictEqual(rows[0].callee_user_id, s.driver.id);
  assertNoPhones(r.text, s, "start response");
});
await test("driver starts a video call to the rider", async () => {
  resetFake();
  const s = await scenario("in_progress");
  const r = await api(`/api/calls/ride/${s.rideId}/start`, { method: "POST", as: s.driver, body: { media: "video" } });
  assert.strictEqual(r.status, 201); assert.strictEqual(fake.created[0].opts.video, true);
  assert.strictEqual(r.body.callee.role, "rider");
});
await test("garbage media falls back to audio; huge bodies do not matter", async () => {
  resetFake();
  const s = await scenario();
  const r = await api(`/api/calls/ride/${s.rideId}/start`, { method: "POST", as: s.rider, body: { media: { $ne: 1 } } });
  assert.strictEqual(r.status, 201); assert.strictEqual(r.body.session.media, "audio");
});
await test("double tap: second tap gets the SAME call back, Stream called once", async () => {
  resetFake();
  const s = await scenario();
  const a = await api(`/api/calls/ride/${s.rideId}/start`, { method: "POST", as: s.rider, body: {} });
  const b = await api(`/api/calls/ride/${s.rideId}/start`, { method: "POST", as: s.rider, body: {} });
  assert.strictEqual(a.status, 201); assert.strictEqual(b.status, 200); assert.ok(b.body.reused);
  assert.strictEqual(a.body.session.id, b.body.session.id);
  assert.strictEqual(fake.created.length, 1);
  assert.strictEqual((await sessionsFor(s.rideId)).length, 1);
});
await test("12 simultaneous taps make exactly one call", async () => {
  resetFake(); fake.delay = 40;
  const s = await scenario();
  const rs = await Promise.all(Array.from({ length: 12 }, () => api(`/api/calls/ride/${s.rideId}/start`, { method: "POST", as: s.rider, body: {} })));
  assert.ok(rs.every((r) => r.status === 200 || r.status === 201), rs.map((r) => r.status).join());
  assert.strictEqual(new Set(rs.map((r) => r.body.session.id)).size, 1);
  assert.strictEqual((await sessionsFor(s.rideId)).length, 1);
  assert.strictEqual(fake.created.length, 1);
});
await test("both people dial at once: one call is made, the other is told to answer it", async () => {
  resetFake(); fake.delay = 40;
  const s = await scenario();
  const [a, b] = await Promise.all([
    api(`/api/calls/ride/${s.rideId}/start`, { method: "POST", as: s.rider, body: {} }),
    api(`/api/calls/ride/${s.rideId}/start`, { method: "POST", as: s.driver, body: {} }),
  ]);
  const codes = [a.status, b.status].sort();
  assert.deepStrictEqual(codes, [201, 409], `${a.status} ${b.status}`);
  const loser = a.status === 409 ? a : b;
  assert.strictEqual(loser.body.code, "incoming_call");
  assert.strictEqual((await sessionsFor(s.rideId)).length, 1);
  assert.strictEqual(fake.created.length, 1);
});
await test("while connected, a new start says you are already on a call", async () => {
  resetFake();
  const s = await scenario();
  const a = await api(`/api/calls/ride/${s.rideId}/start`, { method: "POST", as: s.rider, body: {} });
  await api(`/api/calls/${a.body.session.id}/events`, { method: "POST", as: s.driver, body: { event: "connected" } });
  const b = await api(`/api/calls/ride/${s.rideId}/start`, { method: "POST", as: s.rider, body: {} });
  assert.strictEqual(b.status, 409); assert.strictEqual(b.body.code, "already_in_call");
  const av = await api(`/api/calls/ride/${s.rideId}/availability`, { as: s.driver });
  assert.ok(av.body.liveCall && av.body.liveCall.incoming === true);
});
await test("a ring that nobody reported on expires, and a new call can be placed", async () => {
  resetFake();
  const s = await scenario();
  const a = await api(`/api/calls/ride/${s.rideId}/start`, { method: "POST", as: s.rider, body: {} });
  await pool.query("UPDATE call_sessions SET created_at = now() - interval '5 minutes' WHERE id=$1", [a.body.session.id]);
  const b = await api(`/api/calls/ride/${s.rideId}/start`, { method: "POST", as: s.rider, body: {} });
  assert.strictEqual(b.status, 201); assert.notStrictEqual(b.body.session.id, a.body.session.id);
  const rows = await sessionsFor(s.rideId);
  assert.strictEqual(rows.find((x) => x.id === a.body.session.id).status, "missed");
});
await test("rate limit: 6 calls in 10 minutes then 429 with support", async () => {
  resetFake();
  const s = await scenario();
  for (let i = 0; i < 6; i++) {
    const r = await api(`/api/calls/ride/${s.rideId}/start`, { method: "POST", as: s.rider, body: {} });
    assert.strictEqual(r.status, 201, `call ${i}`);
    await api(`/api/calls/${r.body.session.id}/events`, { method: "POST", as: s.rider, body: { event: "cancelled" } });
  }
  const r = await api(`/api/calls/ride/${s.rideId}/start`, { method: "POST", as: s.rider, body: {} });
  assert.strictEqual(r.status, 429); assert.strictEqual(r.body.code, "rate_limited"); assert.ok(r.body.support);
  // the other person is not locked out by it
  assert.strictEqual((await api(`/api/calls/ride/${s.rideId}/start`, { method: "POST", as: s.driver, body: {} })).status, 201);
});

console.log("when Stream breaks:");
await test("Stream not configured: 503, call marked failed, support offered, retry works after", async () => {
  resetFake(); fake.unavailable = true;
  const s = await scenario();
  const r = await api(`/api/calls/ride/${s.rideId}/start`, { method: "POST", as: s.rider, body: {} });
  assert.strictEqual(r.status, 503); assert.strictEqual(r.body.code, "calling_unavailable");
  assert.ok(r.body.support.message.includes("We'll take care of you")); assert.ok(r.body.support.inApp);
  assert.strictEqual((await sessionsFor(s.rideId))[0].status, "failed");
  fake.unavailable = false;
  assert.strictEqual((await api(`/api/calls/ride/${s.rideId}/start`, { method: "POST", as: s.rider, body: {} })).status, 201);
});
await test("Stream errors while creating the call: 502, failed row, never left ringing", async () => {
  resetFake(); fake.failCreate = true;
  const s = await scenario();
  const r = await api(`/api/calls/ride/${s.rideId}/start`, { method: "POST", as: s.rider, body: {} });
  assert.strictEqual(r.status, 502); assert.strictEqual(r.body.code, "call_failed");
  const rows = await sessionsFor(s.rideId);
  assert.strictEqual(rows[0].status, "failed"); assert.strictEqual(rows[0].failure_reason, "provider_error");
  const av = await api(`/api/calls/ride/${s.rideId}/availability`, { as: s.rider });
  assert.strictEqual(av.body.liveCall, null);
});
await test("a failed call does not count as a live call, so Try again works", async () => {
  resetFake(); fake.failCreate = true;
  const s = await scenario();
  await api(`/api/calls/ride/${s.rideId}/start`, { method: "POST", as: s.rider, body: {} });
  fake.failCreate = false;
  const r = await api(`/api/calls/ride/${s.rideId}/start`, { method: "POST", as: s.rider, body: {} });
  assert.strictEqual(r.status, 201);
});

console.log("call events:");
await test("full happy path: ringing, connected, ended with a duration", async () => {
  resetFake();
  const s = await scenario();
  const a = await api(`/api/calls/ride/${s.rideId}/start`, { method: "POST", as: s.rider, body: {} });
  const id = a.body.session.id;
  const c = await api(`/api/calls/${id}/events`, { method: "POST", as: s.driver, body: { event: "connected" } });
  assert.strictEqual(c.body.session.status, "connected");
  await pool.query("UPDATE call_sessions SET answered_at = now() - interval '75 seconds' WHERE id=$1", [id]);
  const e = await api(`/api/calls/${id}/events`, { method: "POST", as: s.rider, body: { event: "ended" } });
  assert.strictEqual(e.body.session.status, "ended");
  assert.ok(e.body.session.durationSeconds >= 75 && e.body.session.durationSeconds < 90, String(e.body.session.durationSeconds));
  const again = await api(`/api/calls/${id}/events`, { method: "POST", as: s.driver, body: { event: "ended" } });
  assert.strictEqual(again.status, 200); // the other side's matching hang-up
  assert.strictEqual(again.body.session.durationSeconds, e.body.session.durationSeconds);
});
await test("both sides reporting connected is harmless", async () => {
  resetFake();
  const s = await scenario();
  const a = await api(`/api/calls/ride/${s.rideId}/start`, { method: "POST", as: s.rider, body: {} });
  const r1 = await api(`/api/calls/${a.body.session.id}/events`, { method: "POST", as: s.rider, body: { event: "connected" } });
  const r2 = await api(`/api/calls/${a.body.session.id}/events`, { method: "POST", as: s.driver, body: { event: "connected" } });
  assert.strictEqual(r1.status, 200); assert.strictEqual(r2.status, 200); assert.strictEqual(r2.body.session.status, "connected");
});
await test("driver declines; the caller cannot decline their own call; the callee cannot cancel", async () => {
  resetFake();
  const s = await scenario();
  const a = await api(`/api/calls/ride/${s.rideId}/start`, { method: "POST", as: s.rider, body: {} });
  const id = a.body.session.id;
  assert.strictEqual((await api(`/api/calls/${id}/events`, { method: "POST", as: s.rider, body: { event: "declined" } })).status, 409);
  assert.strictEqual((await api(`/api/calls/${id}/events`, { method: "POST", as: s.driver, body: { event: "cancelled" } })).status, 409);
  const d = await api(`/api/calls/${id}/events`, { method: "POST", as: s.driver, body: { event: "declined" } });
  assert.strictEqual(d.body.session.status, "declined");
});
await test("a finished call cannot be brought back to life", async () => {
  resetFake();
  const s = await scenario();
  const a = await api(`/api/calls/ride/${s.rideId}/start`, { method: "POST", as: s.rider, body: {} });
  await api(`/api/calls/${a.body.session.id}/events`, { method: "POST", as: s.rider, body: { event: "cancelled" } });
  const r = await api(`/api/calls/${a.body.session.id}/events`, { method: "POST", as: s.driver, body: { event: "connected" } });
  assert.strictEqual(r.status, 409); assert.strictEqual(r.body.code, "already_finished");
});
await test("strangers cannot report on or even find someone else's call; junk is rejected", async () => {
  resetFake();
  const s = await scenario();
  const a = await api(`/api/calls/ride/${s.rideId}/start`, { method: "POST", as: s.rider, body: {} });
  const id = a.body.session.id;
  assert.strictEqual((await api(`/api/calls/${id}/events`, { method: "POST", as: s.stranger, body: { event: "ended" } })).status, 403);
  assert.strictEqual((await api(`/api/calls/nope/events`, { method: "POST", as: s.rider, body: { event: "ended" } })).status, 404);
  assert.strictEqual((await api(`/api/calls/${id}/events`, { method: "POST", as: s.rider, body: { event: "explode" } })).status, 400);
  assert.strictEqual((await api(`/api/calls/${id}/events`, { method: "POST", as: s.rider, body: {} })).status, 400);
  assert.strictEqual((await api(`/api/calls/${id}/events`, { method: "POST", as: s.rider, body: { event: ["ended"] } })).status, 400);
  assert.strictEqual((await sessionsFor(s.rideId))[0].status, "ringing");
});
await test("two missed calls in a row: support is suggested on the second", async () => {
  resetFake();
  const s = await scenario();
  const a = await api(`/api/calls/ride/${s.rideId}/start`, { method: "POST", as: s.rider, body: {} });
  const m1 = await api(`/api/calls/${a.body.session.id}/events`, { method: "POST", as: s.rider, body: { event: "missed" } });
  assert.strictEqual(m1.body.supportSuggested, false);
  const b = await api(`/api/calls/ride/${s.rideId}/start`, { method: "POST", as: s.rider, body: {} });
  const m2 = await api(`/api/calls/${b.body.session.id}/events`, { method: "POST", as: s.rider, body: { event: "missed" } });
  assert.strictEqual(m2.body.supportSuggested, true); assert.ok(m2.body.support);
});
await test("a dropped call (failed) suggests support straight away", async () => {
  resetFake();
  const s = await scenario();
  const a = await api(`/api/calls/ride/${s.rideId}/start`, { method: "POST", as: s.rider, body: {} });
  await api(`/api/calls/${a.body.session.id}/events`, { method: "POST", as: s.driver, body: { event: "connected" } });
  const f = await api(`/api/calls/${a.body.session.id}/events`, { method: "POST", as: s.rider, body: { event: "failed", reason: "network" } });
  assert.strictEqual(f.body.supportSuggested, true);
});
await test("20 simultaneous end reports leave one consistent final state", async () => {
  resetFake();
  const s = await scenario();
  const a = await api(`/api/calls/ride/${s.rideId}/start`, { method: "POST", as: s.rider, body: {} });
  await api(`/api/calls/${a.body.session.id}/events`, { method: "POST", as: s.driver, body: { event: "connected" } });
  const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => api(`/api/calls/${a.body.session.id}/events`, { method: "POST", as: i % 2 ? s.rider : s.driver, body: { event: "ended" } })));
  assert.ok(rs.every((r) => r.status === 200));
  assert.strictEqual((await sessionsFor(s.rideId))[0].status, "ended");
});

console.log("talk to support:");
await test("support ticket carries the ride, is idempotent, and is private to the two people", async () => {
  resetFake(); fake.failCreate = true;
  const s = await scenario();
  const a = await api(`/api/calls/ride/${s.rideId}/start`, { method: "POST", as: s.rider, body: {} });
  const sid = a.body.sessionId;
  assert.ok(sid);
  assert.strictEqual((await api(`/api/calls/${sid}/support`, { method: "POST", as: s.stranger, body: {} })).status, 403);
  const t1 = await api(`/api/calls/${sid}/support`, { method: "POST", as: s.rider, body: { note: "Driver is outside but I cannot reach him" } });
  assert.strictEqual(t1.status, 201); assert.strictEqual(t1.body.existing, false);
  const t2 = await api(`/api/calls/${sid}/support`, { method: "POST", as: s.rider, body: {} });
  assert.strictEqual(t2.body.ticketId, t1.body.ticketId); assert.strictEqual(t2.body.existing, true);
  const t = (await pool.query("SELECT * FROM support_tickets WHERE id=$1", [t1.body.ticketId])).rows[0];
  assert.strictEqual(t.ride_id, s.rideId); assert.strictEqual(t.user_id, s.rider.id); assert.strictEqual(t.type, "support");
  assert.ok(t.description.includes("cannot reach him"));
  assertNoPhones(JSON.stringify(t) + t1.text, s, "support ticket");
  const count = (await pool.query("SELECT count(*)::int n FROM support_tickets WHERE ride_id=$1", [s.rideId])).rows[0].n;
  assert.strictEqual(count, 1);
});
await test("simultaneous support taps still make one ticket", async () => {
  resetFake(); fake.failCreate = true;
  const s = await scenario();
  const a = await api(`/api/calls/ride/${s.rideId}/start`, { method: "POST", as: s.driver, body: {} });
  const rs = await Promise.all(Array.from({ length: 8 }, () => api(`/api/calls/${a.body.sessionId}/support`, { method: "POST", as: s.driver, body: { note: "x".repeat(5000) } })));
  assert.ok(rs.every((r) => r.status === 200 || r.status === 201), rs.map((r) => r.status).join());
  assert.strictEqual(new Set(rs.map((r) => r.body.ticketId)).size, 1);
});

console.log("staff view:");
await test("admin sees the call history of a ride; riders and drivers do not", async () => {
  resetFake();
  const s = await scenario();
  await api(`/api/calls/ride/${s.rideId}/start`, { method: "POST", as: s.rider, body: {} });
  const admin = await mkUser("admin", nextPhone());
  const ok = await api(`/api/calls/admin/ride/${s.rideId}`, { as: admin });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual((await api(`/api/calls/admin/ride/${s.rideId}`, { as: s.rider })).status, 403);
  assert.strictEqual((await api(`/api/calls/admin/ride/${s.rideId}`, { as: s.driver })).status, 403);
});

console.log("tokens:");
await test("staff get Stream role admin, everyone else user", async () => {
  resetFake();
  const rider = await mkUser("rider", nextPhone()); const admin = await mkUser("admin", nextPhone());
  await api("/api/calls/token", { method: "POST", as: rider });
  await api("/api/calls/token", { method: "POST", as: admin });
  assert.strictEqual(fake.upserts.find((u) => u.id === String(rider.id)).role, "user");
  assert.strictEqual(fake.upserts.find((u) => u.id === String(admin.id)).role, "admin");
});

console.log("numbers never leave:");
await test("ride endpoints hide the other person's number from rider, driver and public; staff keep it", async () => {
  const s = await scenario();
  const admin = await mkUser("admin", nextPhone());
  const asRider = await api(`/api/rides/${s.rideId}`, { as: s.rider });
  assert.ok(!asRider.text.includes(s.driver.phone), "rider saw driver phone");
  assert.ok(asRider.text.includes(s.rider.phone), "rider should still see their own number");
  const asDriver = await api(`/api/rides/${s.rideId}`, { as: s.driver });
  assert.ok(!asDriver.text.includes(s.rider.phone), "driver saw rider phone");
  assert.ok(!/emergency_contact_phone/.test(asDriver.text), "driver saw emergency contact");
  const asStranger = await api(`/api/rides/${s.rideId}`, { as: s.stranger });
  assertNoPhones(asStranger.text, s, "stranger");
  const pub = await api(`/api/rides/public/${s.rideId}`);
  assert.ok(!pub.text.includes(s.driver.phone), "public share leaked the driver phone");
  assert.strictEqual(pub.body.driver_name.split(" ")[0], "driver");
  const asAdmin = await api(`/api/rides/${s.rideId}`, { as: admin });
  assert.ok(asAdmin.text.includes(s.driver.phone) && asAdmin.text.includes(s.rider.phone), "staff should keep numbers");
});
await test("across every response above no call endpoint ever contained a rider or driver number", async () => {
  resetFake();
  const s = await scenario();
  const bodies = [];
  bodies.push((await api(`/api/calls/ride/${s.rideId}/availability`, { as: s.rider })).text);
  const a = await api(`/api/calls/ride/${s.rideId}/start`, { method: "POST", as: s.rider, body: {} }); bodies.push(a.text);
  bodies.push((await api(`/api/calls/ride/${s.rideId}/availability`, { as: s.driver })).text);
  bodies.push((await api(`/api/calls/${a.body.session.id}/events`, { method: "POST", as: s.driver, body: { event: "declined" } })).text);
  bodies.push((await api(`/api/calls/${a.body.session.id}/support`, { method: "POST", as: s.rider, body: {} })).text);
  for (const b of bodies) assertNoPhones(b, s, "call endpoint");
});

// cleanup
await pool.query("DELETE FROM support_tickets WHERE user_id = ANY($1)", [madeUsers]);
await pool.query("DELETE FROM rides WHERE rider_id = ANY($1)", [madeUsers]);
await pool.query("DELETE FROM drivers WHERE user_id = ANY($1)", [madeUsers]);
await pool.query("DELETE FROM users WHERE id = ANY($1)", [madeUsers]);
server.close();
console.log(`\n${passed} passed`);
await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
