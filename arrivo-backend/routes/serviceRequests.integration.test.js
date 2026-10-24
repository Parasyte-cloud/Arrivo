// ArrivoAir / ArrivoBoat / ArrivoRemovals requests against a REAL Postgres and the real route.
//   DATABASE_URL=postgres://... node routes/serviceRequests.integration.test.js
//
// What matters most is checked hardest: a rider only ever touches their own
// requests, a driver only the jobs assigned to them, support cannot change
// anything, nobody but staff ever receives a phone number, a double tap or a
// race never makes two of anything, and the status can only move forward.

const assert = require("assert");
const http = require("http");
const jwt = require("jsonwebtoken");

process.env.JWT_SECRET = process.env.JWT_SECRET || "integration-test-secret";

const express = require("express");
require("express-async-errors");
const { pool, ready } = require("../db/db");
const router = require("./serviceRequests");
const { maskCounterpartyPhones } = require("../services/contactPrivacy");

let passed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.log(`FAIL  ${name}\n      ${e.stack.split("\n").slice(0, 3).join("\n      ")}`); process.exitCode = 1; }
}

const app = express();
app.use(express.json());
app.use("/api/service-requests", maskCounterpartyPhones, router);
app.use((err, req, res, next) => res.status(500).json({ error: "server error", detail: err.message }));
const server = http.createServer(app);

async function api(path, { method = "GET", as, body } = {}) {
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/api/service-requests${path}`, {
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
    "INSERT INTO users (name, email, phone, password_hash, role) VALUES ($1,$2,$3,'x',$4) RETURNING id",
    [`${role} Person${seq} Surname`, `sr-${role}-${seq}-${stamp}@example.com`, phone, role]
  );
  const id = r.rows[0].id;
  madeUsers.push(id);
  const u = { id, role, phone, token: jwt.sign({ id, email: `u${id}@example.com`, role, tv: 0 }, process.env.JWT_SECRET, { algorithm: "HS256" }) };
  if (role === "driver") {
    const d = await pool.query("INSERT INTO drivers (user_id, is_verified) VALUES ($1, true) RETURNING id", [id]);
    u.driverId = d.rows[0].id;
  }
  return u;
}
let phoneSeq = 2000;
const nextPhone = () => `+23481${++phoneSeq}${String(phoneSeq).slice(-3)}66`;
const inHours = (h) => new Date(Date.now() + h * 3600 * 1000).toISOString();

const removalsBody = (extra = {}) => ({
  tier: "removals", pickupAddress: "12 Admiralty Way, Lekki", destinationAddress: "4 Banana Island Rd",
  requestedAt: inHours(72), option: "two_bed", crewSize: 4, contactPhone: nextPhone(), details: "Has a piano", ...extra,
});
const airBody = (extra = {}) => ({
  tier: "air", pickupAddress: "Lagos Heliport", destinationAddress: "Abuja", requestedAt: inHours(24),
  passengerCount: 3, option: "helicopter", contactPhone: nextPhone(), ...extra,
});
const boatBody = (extra = {}) => ({
  tier: "boat", pickupAddress: "Falomo Jetty", destinationAddress: "Lekki Beach", requestedAt: inHours(48),
  passengerCount: 8, option: "speedboat", contactPhone: nextPhone(), ...extra,
});

(async () => {
  await ready;
  await new Promise((r) => server.listen(0, "127.0.0.1", r));

  const rider = await mkUser("rider", nextPhone());
  const other = await mkUser("rider", nextPhone());
  const driver = await mkUser("driver", nextPhone());
  const driver2 = await mkUser("driver", nextPhone());
  const admin = await mkUser("admin", nextPhone());
  const ops = await mkUser("operations", nextPhone());
  const support = await mkUser("support", nextPhone());

  console.log("Rider:");

  await test("sign-in is required everywhere", async () => {
    assert.strictEqual((await api("/")).status, 401);
    assert.strictEqual((await api("/", { method: "POST", body: airBody() })).status, 401);
    assert.strictEqual((await api("/driver/jobs")).status, 401);
    assert.strictEqual((await api("/staff/queue")).status, 401);
    assert.strictEqual((await api("/1/confirm", { method: "POST", body: {} })).status, 401);
  });

  await test("each of the three tiers can be requested and starts pending", async () => {
    for (const body of [airBody(), boatBody(), removalsBody()]) {
      const r = await api("/", { method: "POST", as: rider, body });
      assert.strictEqual(r.status, 201, r.text);
      assert.strictEqual(r.body.request.status, "pending");
      assert.strictEqual(r.body.request.tier, body.tier);
      assert.strictEqual(r.body.request.quotedFareNaira, null);
    }
  });

  await test("a bad request says why and stores nothing", async () => {
    const before = (await pool.query("SELECT count(*)::int AS n FROM service_requests WHERE user_id=$1", [rider.id])).rows[0].n;
    for (const bad of [
      airBody({ tier: "express" }), airBody({ pickupAddress: "" }), airBody({ requestedAt: inHours(-5) }),
      airBody({ option: "yacht" }), airBody({ passengerCount: 99 }), removalsBody({ crewSize: 3 }),
      airBody({ contactPhone: "0801" }),
    ]) {
      const r = await api("/", { method: "POST", as: rider, body: bad });
      assert.strictEqual(r.status, 400, r.text);
      assert.ok(r.body.error);
    }
    const after = (await pool.query("SELECT count(*)::int AS n FROM service_requests WHERE user_id=$1", [rider.id])).rows[0].n;
    assert.strictEqual(after, before);
  });

  await test("the same idempotency key never makes two requests, even in parallel", async () => {
    const body = airBody({ idempotencyKey: `k-${stamp}` });
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => api("/", { method: "POST", as: rider, body })));
    for (const r of results) assert.ok([200, 201].includes(r.status), r.text);
    assert.strictEqual(new Set(results.map((r) => r.body.request.id)).size, 1);
    assert.strictEqual(results.filter((r) => r.status === 201).length, 1);
    const n = (await pool.query("SELECT count(*)::int AS n FROM service_requests WHERE user_id=$1 AND idempotency_key=$2", [rider.id, `k-${stamp}`])).rows[0].n;
    assert.strictEqual(n, 1);
  });

  await test("two different riders can use the same key independently", async () => {
    const key = `shared-${stamp}`;
    const a = await api("/", { method: "POST", as: rider, body: boatBody({ idempotencyKey: key }) });
    const b = await api("/", { method: "POST", as: other, body: boatBody({ idempotencyKey: key }) });
    assert.strictEqual(a.status, 201); assert.strictEqual(b.status, 201);
    assert.notStrictEqual(a.body.request.id, b.body.request.id);
  });

  await test("my list is mine only, newest first, and carries no phone number", async () => {
    const mine = await api("/", { as: rider });
    assert.strictEqual(mine.status, 200);
    assert.ok(mine.body.requests.length >= 3);
    const ids = mine.body.requests.map((r) => r.id);
    assert.deepStrictEqual(ids, [...ids].sort((x, y) => y - x));
    assert.ok(!/\+234\d{8,}/.test(mine.text), "rider list leaked a phone number");
    const theirs = await api("/", { as: other });
    for (const r of theirs.body.requests) assert.ok(!ids.includes(r.id));
  });

  await test("a rider cannot read or cancel someone else's request", async () => {
    const made = await api("/", { method: "POST", as: rider, body: airBody() });
    const id = made.body.request.id;
    assert.strictEqual((await api(`/${id}`, { as: other })).status, 404);
    assert.strictEqual((await api(`/${id}/cancel`, { method: "POST", as: other })).status, 404);
    assert.strictEqual((await api(`/${id}`, { as: rider })).status, 200);
  });

  await test("odd ids are refused, not crashed on", async () => {
    for (const bad of ["abc", "0", "-3", "1.5", "99999999999"]) {
      assert.strictEqual((await api(`/${bad}`, { as: rider })).status, 400, bad);
    }
    assert.strictEqual((await api("/987654", { as: rider })).status, 404);
  });

  await test("a rider can cancel a pending request, once", async () => {
    const id = (await api("/", { method: "POST", as: rider, body: boatBody() })).body.request.id;
    const first = await api(`/${id}/cancel`, { method: "POST", as: rider });
    assert.strictEqual(first.status, 200);
    assert.strictEqual(first.body.request.status, "cancelled");
    assert.strictEqual((await api(`/${id}/cancel`, { method: "POST", as: rider })).status, 409);
  });

  console.log("Staff:");

  await test("riders and drivers cannot see the staff queue; all three staff roles can", async () => {
    assert.strictEqual((await api("/staff/queue", { as: rider })).status, 403);
    assert.strictEqual((await api("/staff/queue", { as: driver })).status, 403);
    for (const s of [admin, ops, support]) assert.strictEqual((await api("/staff/queue", { as: s })).status, 200);
  });

  await test("staff see the rider's contact numbers, oldest request first", async () => {
    const q = await api("/staff/queue", { as: ops });
    assert.ok(q.body.requests.length >= 3);
    const created = q.body.requests.map((r) => r.id);
    assert.deepStrictEqual(created, [...created].sort((a, b) => a - b));
    assert.ok(q.body.requests.every((r) => r.contactPhone && r.riderName));
    assert.ok(q.body.requests.every((r) => ["pending", "confirmed", "in_progress"].includes(r.status)));
  });

  await test("support is read only: cannot confirm or cancel", async () => {
    const id = (await api("/", { method: "POST", as: rider, body: removalsBody() })).body.request.id;
    assert.strictEqual((await api(`/${id}/confirm`, { method: "POST", as: support, body: { fareNaira: 90000, driverId: driver.driverId } })).status, 403);
    assert.strictEqual((await api(`/${id}/staff-cancel`, { method: "POST", as: support })).status, 403);
    assert.strictEqual((await api(`/${id}/confirm`, { method: "POST", as: rider, body: { fareNaira: 90000, driverId: driver.driverId } })).status, 403);
    assert.strictEqual((await api(`/${id}/confirm`, { method: "POST", as: driver, body: { fareNaira: 90000, driverId: driver.driverId } })).status, 403);
  });

  await test("operations can read the queue but cannot change anything", async () => {
    const id = (await api("/", { method: "POST", as: rider, body: removalsBody() })).body.request.id;
    assert.strictEqual((await api("/staff/queue", { as: ops })).status, 200);
    assert.strictEqual((await api(`/${id}/confirm`, { method: "POST", as: ops, body: { fareNaira: 90000, driverId: driver.driverId } })).status, 403);
    assert.strictEqual((await api(`/${id}/staff-cancel`, { method: "POST", as: ops })).status, 403);
    assert.strictEqual((await api(`/${id}`, { as: rider })).body.request.status, "pending");
  });

  await test("confirm needs a valid fare and a real, verified driver", async () => {
    const id = (await api("/", { method: "POST", as: rider, body: removalsBody() })).body.request.id;
    assert.strictEqual((await api(`/${id}/confirm`, { method: "POST", as: admin, body: { fareNaira: 10, driverId: driver.driverId } })).status, 400);
    assert.strictEqual((await api(`/${id}/confirm`, { method: "POST", as: admin, body: { fareNaira: 90000 } })).status, 400);
    assert.strictEqual((await api(`/${id}/confirm`, { method: "POST", as: admin, body: { fareNaira: 90000, driverId: 2000000 } })).status, 400);
    const unverified = await mkUser("driver", nextPhone());
    await pool.query("UPDATE drivers SET is_verified=false WHERE id=$1", [unverified.driverId]);
    const r = await api(`/${id}/confirm`, { method: "POST", as: admin, body: { fareNaira: 90000, driverId: unverified.driverId } });
    assert.strictEqual(r.status, 400);
    assert.ok(/verified/.test(r.body.error));
    assert.strictEqual((await api(`/${id}`, { as: rider })).body.request.status, "pending");
  });

  console.log("Confirm and run a job:");

  let jobId;
  await test("admin confirms with a price and a driver; the rider sees the price", async () => {
    jobId = (await api("/", { method: "POST", as: rider, body: removalsBody() })).body.request.id;
    const r = await api(`/${jobId}/confirm`, { method: "POST", as: admin, body: { fareNaira: 120000, driverId: driver.driverId } });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.request.status, "confirmed");
    const seen = await api(`/${jobId}`, { as: rider });
    assert.strictEqual(seen.body.request.quotedFareNaira, 120000);
    assert.ok(!/driver/i.test(Object.keys(seen.body.request).join(",")), "rider view must not expose driver internals");
  });

  await test("confirming twice, or two staff at once, only works once", async () => {
    assert.strictEqual((await api(`/${jobId}/confirm`, { method: "POST", as: admin, body: { fareNaira: 1500, driverId: driver2.driverId } })).status, 409);
    const id = (await api("/", { method: "POST", as: rider, body: airBody() })).body.request.id;
    const results = await Promise.all([
      api(`/${id}/confirm`, { method: "POST", as: admin, body: { fareNaira: 500000, driverId: driver.driverId } }),
      api(`/${id}/confirm`, { method: "POST", as: admin, body: { fareNaira: 600000, driverId: driver2.driverId } }),
    ]);
    assert.deepStrictEqual(results.map((r) => r.status).sort(), [200, 409]);
    const row = (await pool.query("SELECT driver_id, quoted_fare_naira FROM service_requests WHERE id=$1", [id])).rows[0];
    const winner = results.find((r) => r.status === 200);
    assert.strictEqual(row.quoted_fare_naira, winner.body.request.quotedFareNaira);
  });

  await test("the assigned driver sees the job with a first name and no phone numbers", async () => {
    const r = await api("/driver/jobs", { as: driver });
    assert.strictEqual(r.status, 200);
    const job = r.body.jobs.find((j) => j.id === jobId);
    assert.ok(job);
    assert.strictEqual(job.fareNaira, 120000);
    assert.strictEqual(job.riderFirstName, "rider");
    assert.ok(!/\+234\d{8,}/.test(r.text), "driver list leaked a phone number");
    assert.ok(!r.text.includes("Surname"));
  });

  await test("another driver, a rider or staff-as-driver sees nothing of it", async () => {
    assert.ok(!(await api("/driver/jobs", { as: driver2 })).body.jobs.some((j) => j.id === jobId));
    assert.strictEqual((await api("/driver/jobs", { as: rider })).status, 403);
    assert.strictEqual((await api(`/${jobId}/status`, { method: "PATCH", as: driver2, body: { status: "in_progress" } })).status, 404);
    assert.strictEqual((await api(`/${jobId}/status`, { method: "PATCH", as: rider, body: { status: "in_progress" } })).status, 403);
  });

  await test("the driver cannot skip steps or invent statuses", async () => {
    for (const s of ["completed", "cancelled", "pending", "confirmed", "banana", undefined]) {
      assert.strictEqual((await api(`/${jobId}/status`, { method: "PATCH", as: driver, body: { status: s } })).status, 409, String(s));
    }
  });

  await test("start then complete; tapping start twice does no harm", async () => {
    const a = await api(`/${jobId}/status`, { method: "PATCH", as: driver, body: { status: "in_progress" } });
    assert.strictEqual(a.status, 200);
    assert.strictEqual(a.body.job.status, "in_progress");
    assert.strictEqual((await api(`/${jobId}/status`, { method: "PATCH", as: driver, body: { status: "in_progress" } })).status, 409);
    assert.strictEqual((await api(`/${jobId}/cancel`, { method: "POST", as: rider })).status, 409, "rider cannot cancel mid trip");
    const b = await api(`/${jobId}/status`, { method: "PATCH", as: driver, body: { status: "completed" } });
    assert.strictEqual(b.status, 200);
    const row = (await pool.query("SELECT status, completed_at FROM service_requests WHERE id=$1", [jobId])).rows[0];
    assert.strictEqual(row.status, "completed");
    assert.ok(row.completed_at);
    assert.ok(!(await api("/driver/jobs", { as: driver })).body.jobs.some((j) => j.id === jobId), "finished job leaves the list");
  });

  await test("a finished job cannot be reopened or cancelled by anyone", async () => {
    assert.strictEqual((await api(`/${jobId}/status`, { method: "PATCH", as: driver, body: { status: "in_progress" } })).status, 409);
    assert.strictEqual((await api(`/${jobId}/staff-cancel`, { method: "POST", as: admin })).status, 409);
    assert.strictEqual((await api(`/${jobId}/cancel`, { method: "POST", as: rider })).status, 409);
  });

  await test("a cancelled request disappears from the staff queue and cannot be confirmed", async () => {
    const id = (await api("/", { method: "POST", as: rider, body: boatBody() })).body.request.id;
    assert.strictEqual((await api(`/${id}/staff-cancel`, { method: "POST", as: admin })).status, 200);
    assert.ok(!(await api("/staff/queue", { as: ops })).body.requests.some((r) => r.id === id));
    assert.strictEqual((await api(`/${id}/confirm`, { method: "POST", as: admin, body: { fareNaira: 5000, driverId: driver.driverId } })).status, 409);
    assert.strictEqual((await api(`/${id}/confirm`, { method: "POST", as: admin, body: { fareNaira: 5000, driverId: driver.driverId } })).body.error.includes("cancelled"), true);
  });

  await test("staff can cancel a confirmed job and it leaves the driver's list", async () => {
    const id = (await api("/", { method: "POST", as: rider, body: airBody() })).body.request.id;
    await api(`/${id}/confirm`, { method: "POST", as: admin, body: { fareNaira: 700000, driverId: driver2.driverId } });
    assert.ok((await api("/driver/jobs", { as: driver2 })).body.jobs.some((j) => j.id === id));
    assert.strictEqual((await api(`/${id}/staff-cancel`, { method: "POST", as: admin })).status, 200);
    assert.ok(!(await api("/driver/jobs", { as: driver2 })).body.jobs.some((j) => j.id === id));
  });

  console.log("Database rules:");

  await test("the table itself refuses a bad tier or status", async () => {
    await assert.rejects(pool.query("INSERT INTO service_requests (user_id,tier,pickup_address,destination_address,requested_at,contact_phone) VALUES ($1,'express','a','b',now(),'+2348000000000')", [rider.id]));
    await assert.rejects(pool.query("UPDATE service_requests SET status='lost' WHERE user_id=$1", [rider.id]));
  });

  // cleanup
  await pool.query("DELETE FROM service_requests WHERE user_id = ANY($1)", [madeUsers]);
  await pool.query("DELETE FROM drivers WHERE user_id = ANY($1)", [madeUsers]);
  await pool.query("DELETE FROM users WHERE id = ANY($1)", [madeUsers]);
  server.close();
  console.log(`\n${passed} passed`);
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
