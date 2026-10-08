// Public (no sign-in) routes: waitlist and the shared tracking link.
//   DATABASE_URL=postgres://localhost/... node routes/publicRoutes.integration.test.js

const assert = require("assert");
const http = require("http");

process.env.JWT_SECRET = process.env.JWT_SECRET || "integration-test-secret";
process.env.WAITLIST_RATE_LIMIT = "4";

const express = require("express");
require("express-async-errors");
const { pool } = require("../db/db");

const app = express();
app.use(express.json());
app.use("/api/waitlist", require("./waitlist"));
app.use("/api/rides", require("./rides"));
app.use((err, req, res, next) => res.status(500).json({ error: "server error", detail: err.message }));
const server = http.createServer(app);

let passed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.log(`FAIL  ${name}`); console.log(`      ${e.stack || e.message}`); process.exitCode = 1; }
}
async function call(path, { method = "GET", body } = {}) {
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const stamp = Date.now();
const userIds = [];
async function makeRide(status, tag) {
  const u = (await pool.query(
    `INSERT INTO users (name, email, password_hash, role, agreed_to_terms, email_verified) VALUES ($1,$2,'x','rider',true,true) RETURNING id`,
    [`Pub ${tag}`, `pub-${tag}-${stamp}@example.com`])).rows[0];
  userIds.push(u.id);
  const token = `trk${stamp}${tag}`.padEnd(32, "0");
  await pool.query(
    `INSERT INTO rides (rider_id, pickup_address, stops, vehicle_type, fare_naira, ride_status, share_token, booking_type, agreed_cancellation_policy)
     VALUES ($1,'Airport','[]','sedan',1000,$2,$3,'one_way',true)`, [u.id, status, token]);
  return token;
}

(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));

  console.log("Tracking link:");
  await test("a finished trip no longer exposes the driver phone or position", async () => {
    const t = await makeRide("completed", "done");
    const r = await call(`/api/rides/track/${t}`);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.ride.ride_status, "completed");
    assert.strictEqual(r.body.ride.driver_phone ?? null, null);
    assert.strictEqual(r.body.ride.current_lat ?? null, null);
  });
  await test("a live trip still returns its status", async () => {
    const t = await makeRide("requested", "live");
    const r = await call(`/api/rides/track/${t}`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ride.ride_status, "requested");
  });
  await test("an unknown token is a 404", async () => {
    const r = await call("/api/rides/track/not-a-real-token");
    assert.strictEqual(r.status, 404);
  });

  console.log("Waitlist:");
  await test("rejects oversized emails and truncates the source", async () => {
    const long = `${"a".repeat(250)}@example.com`;
    const bad = await call("/api/waitlist", { method: "POST", body: { email: long } });
    assert.strictEqual(bad.status, 400);
    const email = `wl-${stamp}@example.com`;
    const ok = await call("/api/waitlist", { method: "POST", body: { email, source: "s".repeat(500) } });
    assert.strictEqual(ok.status, 201, JSON.stringify(ok.body));
    const row = (await pool.query("SELECT source FROM waitlist WHERE email = $1", [email])).rows[0];
    assert.strictEqual(row.source.length, 64);
  });
  await test("sign-ups are rate limited per IP", async () => {
    let limited = null;
    for (let i = 0; i < 10 && !limited; i++) {
      const r = await call("/api/waitlist", { method: "POST", body: { email: `wl-${stamp}-${i}@example.com` } });
      if (r.status === 429) limited = r;
    }
    assert.ok(limited, "never rate limited");
    assert.ok(limited.body.error);
  });

  await pool.query("DELETE FROM waitlist WHERE email LIKE $1", [`wl-${stamp}%`]).catch(() => {});
  for (const id of userIds) {
    await pool.query("DELETE FROM rides WHERE rider_id = $1", [id]).catch(() => {});
    await pool.query("DELETE FROM users WHERE id = $1", [id]).catch(() => {});
  }
  server.close();
  await pool.end();
  console.log(`\n${passed} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
