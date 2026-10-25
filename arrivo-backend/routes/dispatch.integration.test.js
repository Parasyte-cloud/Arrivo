// Run: DATABASE_URL=... node routes/dispatch.integration.test.js
// Getting a driver onto a ride (services/dispatch.js) against a real database:
// who gets alerted, reminders, and assigning or changing a driver from the console.
const assert = require("assert");
const http = require("http");
const jwt = require("jsonwebtoken");

process.env.JWT_SECRET = process.env.JWT_SECRET || "integration-test-secret";

// Record pushes instead of sending them.
const pushes = [];
const pushPath = require.resolve("../services/pushNotifications");
require.cache[pushPath] = {
  id: pushPath, filename: pushPath, loaded: true,
  exports: { sendPushNotification: async (token, title, body, data) => { if (token) pushes.push({ token, title, body, data }); return { ok: true }; } },
};

const express = require("express");
require("express-async-errors");
const { pool, ready } = require("../db/db");
const dispatch = require("../services/dispatch");

let passed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok  ${name}`); passed++; } catch (e) { console.log(`FAIL  ${name}\n      ${e.stack || e.message}`); process.exitCode = 1; }
}

const app = express();
app.use(express.json());
app.use("/api/admin", require("./admin"));
app.use((err, req, res, next) => res.status(500).json({ error: "server error", detail: err.message }));
const server = http.createServer(app);
async function call(path, token, { method = "GET", body } = {}) {
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const stamp = Date.now();
const users = [];
const rides = [];
async function makeUser(tag, role, pushToken = null) {
  const email = `dsp-${tag}-${stamp}@example.com`;
  const row = (await pool.query(
    `INSERT INTO users (name, email, password_hash, role, agreed_to_terms, email_verified, phone, push_token)
     VALUES ($1, $2, 'x', $3, true, true, '+2348012345678', $4) RETURNING id, token_version`,
    [`Dsp ${tag}`, email, role, pushToken])).rows[0];
  users.push(row.id);
  return { id: row.id, token: jwt.sign({ id: row.id, email, role, tv: row.token_version }, process.env.JWT_SECRET, { expiresIn: "1h" }) };
}
async function makeDriver(tag, { verified = true, online = true, push = true, lat = 6.6, lng = 3.35 } = {}) {
  const u = await makeUser(tag, "driver", push ? `ExponentPushToken[${tag}-${stamp}]` : null);
  const d = (await pool.query(
    `INSERT INTO drivers (user_id, is_verified, is_online, current_lat, current_lng, location_updated_at) VALUES ($1,$2,$3,$4,$5, now()) RETURNING id`,
    [u.id, verified, online, lat, lng])).rows[0];
  return { ...u, driverId: d.id, pushToken: push ? `ExponentPushToken[${tag}-${stamp}]` : null };
}
async function makeRide(riderId, extra = {}) {
  const cols = { rider_id: riderId, pickup_address: "Murtala Muhammed Airport, Ikeja, Lagos", stops: JSON.stringify(["Victoria Island, Lagos"]),
    vehicle_type: "sedan", fare_naira: 30000, booking_type: "one_way", ride_status: "requested", pickup_lat: 6.58, pickup_lng: 3.32, ...extra };
  const keys = Object.keys(cols);
  const id = (await pool.query(`INSERT INTO rides (${keys.join(",")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(",")}) RETURNING id`, Object.values(cols))).rows[0].id;
  rides.push(id);
  return id;
}
const events = async (rideId) => (await pool.query("SELECT kind, drivers_alerted, actor_id, driver_id, from_driver_id FROM ride_dispatch_events WHERE ride_id = $1 ORDER BY id", [rideId])).rows;
// Other suites' drivers may be online in the same database, so only this run's tokens count.
const mine = (t) => String(t).endsWith(`-${stamp}]`);
const tokensPushed = (title) => pushes.filter((p) => p.title === title && mine(p.token)).map((p) => p.token);
const tick = () => new Promise((r) => setTimeout(r, 150));

(async () => {
  // Startup applies schema.sql; writing before it finishes can deadlock.
  await ready;
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const rider = await makeUser("rider", "rider", `ExponentPushToken[rider-${stamp}]`);
    const admin = await makeUser("admin", "admin");
    const ops = await makeUser("ops", "operations");
    const near = await makeDriver("near", { lat: 6.581, lng: 3.321 });
    const far = await makeDriver("far", { lat: 6.45, lng: 3.6 });
    const offline = await makeDriver("offline", { online: false });
    const unverified = await makeDriver("unverified", { verified: false });
    const noPush = await makeDriver("nopush", { push: false });

    let rideId;
    await test("a booking alerts every online, approved driver with a push token, and nobody else", async () => {
      rideId = await makeRide(rider.id);
      pushes.length = 0;
      const out = await dispatch.alertDrivers(rideId);
      assert.ok(out.alerted >= 2);
      assert.deepStrictEqual(tokensPushed("New ride available").sort(), [near.pushToken, far.pushToken].sort());
      assert.deepStrictEqual((await events(rideId)).map((e) => e.kind), ["alerted"]);
    });

    await test("the alert says where and when, never who", async () => {
      const p = pushes.find((x) => x.title === "New ride available");
      assert.match(p.body, /Murtala Muhammed Airport → Victoria Island/);
      assert.ok(!p.body.includes("Dsp rider") && !p.body.includes("2348012345678"));
      assert.deepStrictEqual(p.data, { rideId, type: "new_ride" });
    });

    await test("a ride held for a preferred driver alerts that driver only", async () => {
      const held = await makeRide(rider.id, { preferred_driver_id: far.driverId });
      pushes.length = 0;
      await dispatch.alertDrivers(held);
      assert.deepStrictEqual(pushes.map((p) => [p.token, p.title]), [[far.pushToken, "A rider asked for you"]], "nobody else, not even other suites' drivers");
    });

    await test("2 hours before pickup an unassigned ride gets one reminder round, not more", async () => {
      const soon = await makeRide(rider.id, { scheduled_pickup_at: new Date(Date.now() + 60 * 60 * 1000) });
      pushes.length = 0;
      await dispatch.sweepUnassigned();
      assert.ok(tokensPushed("New ride available").includes(near.pushToken));
      assert.deepStrictEqual((await events(soon)).map((e) => e.kind), ["reminder"]);
      await dispatch.sweepUnassigned();
      assert.deepStrictEqual((await events(soon)).map((e) => e.kind), ["reminder"], "no second reminder");
    });

    await test("console: the driver list puts online drivers first, nearest first", async () => {
      const r = await call(`/api/admin/trips/${rideId}/drivers`, ops.token);
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      const mine = r.body.drivers.filter((d) => [near.driverId, far.driverId, offline.driverId, noPush.driverId].includes(d.id));
      assert.strictEqual(mine[0].id, near.driverId, "nearest online first");
      assert.ok(mine.findIndex((d) => d.id === offline.driverId) > mine.findIndex((d) => d.id === far.driverId), "offline after online");
      assert.ok(!r.body.drivers.some((d) => d.id === unverified.driverId), "unapproved drivers aren't offered");
      assert.ok(mine[0].kmToPickup < 1);
    });

    await test("console: operations can look but not assign", async () => {
      const r = await call(`/api/admin/trips/${rideId}/assign-driver`, ops.token, { method: "POST", body: { driverId: near.driverId } });
      assert.strictEqual(r.status, 403);
    });

    await test("console: an admin assigns a driver, and the rider and the driver both hear", async () => {
      pushes.length = 0;
      const r = await call(`/api/admin/trips/${rideId}/assign-driver`, admin.token, { method: "POST", body: { driverId: near.driverId, note: "Called him, he's free" } });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      await tick();
      const ride = (await pool.query("SELECT ride_status, driver_id FROM rides WHERE id = $1", [rideId])).rows[0];
      assert.deepStrictEqual(ride, { ride_status: "accepted", driver_id: near.driverId });
      assert.deepStrictEqual(tokensPushed("Ride assigned to you"), [near.pushToken]);
      assert.deepStrictEqual(tokensPushed("Driver on the way"), [`ExponentPushToken[rider-${stamp}]`]);
      const ev = (await events(rideId)).pop();
      assert.deepStrictEqual([ev.kind, ev.actor_id, ev.driver_id], ["assigned", admin.id, near.driverId]);
    });

    await test("console: changing the driver tells the old one, and is logged as a change", async () => {
      pushes.length = 0;
      const r = await call(`/api/admin/trips/${rideId}/assign-driver`, admin.token, { method: "POST", body: { driverId: far.driverId } });
      assert.strictEqual(r.status, 200);
      await tick();
      assert.deepStrictEqual(tokensPushed("Ride moved to another driver"), [near.pushToken]);
      assert.deepStrictEqual(tokensPushed("Ride assigned to you"), [far.pushToken]);
      const ev = (await events(rideId)).pop();
      assert.deepStrictEqual([ev.kind, ev.driver_id, ev.from_driver_id], ["reassigned", far.driverId, near.driverId]);
    });

    await test("the dispatch log reads in order with names", async () => {
      const r = await call(`/api/admin/trips/${rideId}/dispatch`, ops.token);
      assert.deepStrictEqual(r.body.events.map((e) => e.kind), ["reassigned", "assigned", "alerted"]);
      assert.strictEqual(r.body.events[0].from_driver_name, "Dsp near");
      assert.strictEqual(r.body.events[1].actor_name, "Dsp admin");
    });

    await test("refused: an unapproved driver, the same driver, a finished ride, re-alerting a ride that has a driver", async () => {
      assert.strictEqual((await call(`/api/admin/trips/${rideId}/assign-driver`, admin.token, { method: "POST", body: { driverId: unverified.driverId } })).body.code, "not_verified");
      assert.strictEqual((await call(`/api/admin/trips/${rideId}/assign-driver`, admin.token, { method: "POST", body: { driverId: far.driverId } })).body.code, "same_driver");
      const done = await makeRide(rider.id, { ride_status: "completed" });
      assert.strictEqual((await call(`/api/admin/trips/${done}/assign-driver`, admin.token, { method: "POST", body: { driverId: near.driverId } })).body.code, "wrong_status");
      assert.strictEqual((await call(`/api/admin/trips/${rideId}/alert-drivers`, admin.token, { method: "POST" })).status, 409);
      assert.strictEqual((await call(`/api/admin/trips/${rideId}/assign-driver`, admin.token, { method: "POST", body: { driverId: "x" } })).status, 400);
    });

    await test("two people assigning at the same moment end with one driver and both steps logged", async () => {
      const race = await makeRide(rider.id);
      const [a, b] = await Promise.all([
        call(`/api/admin/trips/${race}/assign-driver`, admin.token, { method: "POST", body: { driverId: near.driverId } }),
        call(`/api/admin/trips/${race}/assign-driver`, admin.token, { method: "POST", body: { driverId: far.driverId } }),
      ]);
      assert.deepStrictEqual([a.status, b.status].sort(), [200, 200]);
      const ride = (await pool.query("SELECT driver_id FROM rides WHERE id = $1", [race])).rows[0];
      const ev = await events(race);
      assert.deepStrictEqual(ev.map((e) => e.kind), ["assigned", "reassigned"]);
      assert.strictEqual(ride.driver_id, ev[1].driver_id, "the ride ends with whoever the log says");
    });
  } finally {
    if (rides.length) {
      await pool.query("DELETE FROM ride_dispatch_events WHERE ride_id = ANY($1)", [rides]).catch(() => {});
      await pool.query("DELETE FROM ride_team_events WHERE ride_id = ANY($1)", [rides]).catch(() => {});
      await pool.query("DELETE FROM ride_team WHERE ride_id = ANY($1)", [rides]).catch(() => {});
      await pool.query("DELETE FROM rides WHERE id = ANY($1)", [rides]).catch(() => {});
    }
    if (users.length) {
      await pool.query("DELETE FROM drivers WHERE user_id = ANY($1)", [users]).catch(() => {});
      await pool.query("DELETE FROM users WHERE id = ANY($1)", [users]).catch(() => {});
    }
    server.close();
    await pool.end();
    console.log(`\ndispatch integration: ${passed} passed`);
  }
})();
