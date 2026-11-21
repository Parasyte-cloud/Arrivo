// Driver tier access, against a REAL Postgres.
//   DATABASE_URL=postgres://... node routes/driverTiers.integration.test.js
// Covers: who may grant (owner, a person the owner names, never a plain admin),
// grant / withdraw with a reason, the history, driver requests that never switch
// anything on, going online with no tier, and that work from one tier never
// reaches a driver who does not hold it. Aimed at a throwaway database.

// These tests are about services and tiers, not the daily subscription.
process.env.DRIVER_SUBSCRIPTION_ENFORCED = "false";
const assert = require("assert");
const http = require("http");
const fs = require("fs");
const path = require("path");
const jwt = require("jsonwebtoken");

process.env.JWT_SECRET = process.env.JWT_SECRET || "integration-test-secret";
process.env.ARRIVO_NOW_ENABLED = "true";

const express = require("express");
require("express-async-errors");
const { pool, ready } = require("../db/db");
const tiersRouter = require("./adminDriverTiers");
const { router: driversRouter } = require("./drivers");
const ridesRouter = require("./rides");
const instantRouter = require("./instantRides");
const peopleRouter = require("./staffPeople");
const { createDriverTiers } = require("../services/driverTiers");

let passed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.log(`FAIL  ${name}\n      ${e.stack.split("\n").slice(0, 3).join("\n      ")}`); process.exitCode = 1; }
}

const app = express();
app.use(express.json());
app.use("/api/admin/driver-tiers", tiersRouter);
app.use("/api/drivers", driversRouter);
app.use("/api/rides", ridesRouter);
app.use("/api/instant-rides", instantRouter);
app.use("/api/staff/people", peopleRouter);
app.use((err, req, res, next) => res.status(500).json({ error: "server error", detail: err.message }));
const server = http.createServer(app);

async function api(p, { method = "GET", as, body } = {}) {
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: { "Content-Type": "application/json", ...(as ? { Authorization: `Bearer ${as.token}` } : {}) },
    body: body === undefined || method === "GET" ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = {}; try { json = JSON.parse(text); } catch (_) {}
  return { status: res.status, body: json };
}

const stamp = Date.now();
let seq = 0;
const madeUsers = [];
async function mkUser(role, { owner = false, name } = {}) {
  seq++;
  const r = await pool.query(
    "INSERT INTO users (name, email, phone, password_hash, role, is_owner) VALUES ($1,$2,$3,'x',$4,$5) RETURNING id",
    [name || `${role}${seq} Tester`, `tier-${role}-${seq}-${stamp}@example.com`, `+23480${String(2000000 + seq)}${seq}`, role, owner]
  );
  const id = r.rows[0].id; madeUsers.push(id);
  return { id, role, token: jwt.sign({ id, email: `u${id}@example.com`, role, tv: 0 }, process.env.JWT_SECRET, { algorithm: "HS256" }) };
}
async function mkDriver(name) {
  const u = await mkUser("driver", { name });
  const d = (await pool.query("INSERT INTO drivers (user_id, is_verified) VALUES ($1, true) RETURNING id", [u.id])).rows[0].id;
  return { ...u, driverId: d };
}
async function mkRide(bookingType) {
  const rider = await mkUser("rider");
  const r = await pool.query(
    "INSERT INTO rides (rider_id, pickup_address, fare_naira, ride_status, booking_type) VALUES ($1,'Ikeja',9000,'requested',$2) RETURNING id",
    [rider.id, bookingType]
  );
  return r.rows[0].id;
}
const grant = (as, driverId, tier, note) => api("/api/admin/driver-tiers/grant", { method: "POST", as, body: { driverId, tier, note } });
const revoke = (as, driverId, tier, note) => api("/api/admin/driver-tiers/revoke", { method: "POST", as, body: { driverId, tier, note } });

(async () => {
  await ready;
  await new Promise((r) => server.listen(0, r));
  const owner = await mkUser("admin", { owner: true, name: "Owner Person" });
  const admin = await mkUser("admin", { name: "Plain Admin" });
  const helper = await mkUser("support", { name: "Named Helper" });
  const d1 = await mkDriver("Driver One");
  const d2 = await mkDriver("Driver Two");

  await test("a plain admin cannot see or change driver tiers", async () => {
    assert.strictEqual((await api("/api/admin/driver-tiers", { as: admin })).status, 403);
    assert.strictEqual((await grant(admin, d1.driverId, "express")).status, 403);
    assert.strictEqual((await revoke(admin, d1.driverId, "express", "no")).status, 403);
  });

  await test("a rider and a driver cannot reach the console API", async () => {
    const rider = await mkUser("rider");
    assert.strictEqual((await api("/api/admin/driver-tiers", { as: rider })).status, 403);
    assert.strictEqual((await grant(d1, d1.driverId, "express")).status, 403);
  });

  await test("the owner switches tiers on, a driver can hold several", async () => {
    assert.strictEqual((await grant(owner, d1.driverId, "ride", "Airport team")).status, 200);
    assert.strictEqual((await grant(owner, d1.driverId, "express")).status, 200);
    const r = await grant(owner, d1.driverId, "campus");
    assert.deepStrictEqual(r.body.tiers.filter((t) => t.status === "active").map((t) => t.slug).sort(), ["campus", "express", "ride"]);
    const list = await api("/api/admin/driver-tiers?q=Driver One", { as: owner });
    assert.strictEqual(list.status, 200);
    assert.strictEqual(list.body.you.canManage, true);
    const row = list.body.drivers.find((d) => d.id === d1.driverId);
    assert.strictEqual(row.tiers.length, 7);
    assert.strictEqual(row.tiers.find((t) => t.slug === "boat").status, "off");
  });

  await test("bad input is refused", async () => {
    assert.strictEqual((await grant(owner, d1.driverId, "nope")).status, 400);
    assert.strictEqual((await grant(owner, 999999, "ride")).status, 404);
    assert.strictEqual((await api("/api/admin/driver-tiers/grant", { method: "POST", as: owner, body: { tier: "ride" } })).status, 400);
  });

  await test("withdrawing needs a reason and leaves the other tiers alone", async () => {
    const noReason = await revoke(owner, d1.driverId, "campus", "");
    assert.strictEqual(noReason.status, 400);
    assert.strictEqual(noReason.body.code, "tier_reason_required");
    const ok = await revoke(owner, d1.driverId, "campus", "Left the programme");
    assert.strictEqual(ok.status, 200);
    assert.deepStrictEqual(ok.body.tiers.filter((t) => t.status === "active").map((t) => t.slug).sort(), ["express", "ride"]);
    assert.strictEqual(ok.body.tiers.find((t) => t.slug === "campus").status, "revoked");
  });

  await test("every change is in the history, newest first, with who did it", async () => {
    const ev = await api(`/api/admin/driver-tiers/events/${d1.driverId}`, { as: owner });
    assert.strictEqual(ev.status, 200);
    assert.deepStrictEqual(ev.body.events.map((e) => `${e.action}:${e.tier}`), ["revoked:campus", "granted:campus", "granted:express", "granted:ride"]);
    assert.strictEqual(ev.body.events[0].actor_name, "Owner Person");
    assert.strictEqual(ev.body.events[0].note, "Left the programme");
  });

  await test("only the owner can hand the power to someone, and then they can use it", async () => {
    // Make the helper a person the owner can manage: support role, no tiers area yet.
    assert.strictEqual((await api("/api/admin/driver-tiers", { as: helper })).status, 403);
    // An admin who may manage staff still cannot give it away.
    await pool.query("UPDATE users SET can_manage_staff = true WHERE id = $1", [admin.id]);
    const byAdmin = await api(`/api/staff/people/${helper.id}/permissions`, { method: "PUT", as: admin, body: { permissions: { "driver-tiers": "manage" } } });
    assert.strictEqual(byAdmin.status, 403);
    assert.strictEqual(byAdmin.body.code, "OWNER_ONLY");
    // A whole-map save that leaves the area alone is not blocked by that rule.
    const same = await api(`/api/staff/people/${helper.id}/permissions`, { method: "PUT", as: admin, body: { permissions: { "driver-tiers": "none", riders: "view" } } });
    assert.notStrictEqual(same.body.code, "OWNER_ONLY");
    // The owner can.
    const byOwner = await api(`/api/staff/people/${helper.id}/permissions`, { method: "PUT", as: owner, body: { permissions: { "driver-tiers": "manage" } } });
    assert.strictEqual(byOwner.status, 200, JSON.stringify(byOwner.body));
    assert.strictEqual((await grant(helper, d2.driverId, "chauffeur", "Approved by owner")).status, 200);
    // View only: can look, cannot change.
    await api(`/api/staff/people/${helper.id}/permissions`, { method: "PUT", as: owner, body: { permissions: { "driver-tiers": "view" } } });
    assert.strictEqual((await api("/api/admin/driver-tiers", { as: helper })).body.you.canManage, false);
    assert.strictEqual((await grant(helper, d2.driverId, "boat")).status, 403);
    // Take it away again.
    await api(`/api/staff/people/${helper.id}/permissions`, { method: "PUT", as: owner, body: { permissions: { "driver-tiers": "none" } } });
    assert.strictEqual((await api("/api/admin/driver-tiers", { as: helper })).status, 403);
    await revoke(owner, d2.driverId, "chauffeur", "Test cleanup");
  });

  await test("a driver sees only their own services and the decider is not exposed", async () => {
    const mine = await api("/api/drivers/tiers", { as: d1 });
    assert.strictEqual(mine.status, 200);
    assert.deepStrictEqual(mine.body.active.sort(), ["express", "ride"]);
    const raw = JSON.stringify(mine.body);
    assert.ok(!/decided|actor|Owner Person|Left the programme/.test(raw), raw);
    assert.deepStrictEqual((await api("/api/drivers/tiers", { as: d2 })).body.active, []);
    assert.strictEqual((await api("/api/drivers/tiers", { as: await mkUser("rider") })).status, 403);
  });

  await test("a driver is shown ONLY the services Ops switched on, never the others", async () => {
    await grant(owner, d2.driverId, "campus", "for visibility test");
    await revoke(owner, d2.driverId, "campus", "withdrawn again");
    const mine = await api("/api/drivers/tiers", { as: d1 });
    assert.deepStrictEqual(mine.body.tiers.map((t) => t.slug).sort(), ["express", "ride"], "only what is on is listed");
    assert.ok(mine.body.tiers.every((t) => t.status === "active"));
    const raw = JSON.stringify(mine.body);
    for (const hidden of ["ArrivoCampus", "ArrivoAir", "ArrivoBoat", "ArrivoRemovals", "ArrivoChauffeur", "revoked", "requested"]) {
      assert.ok(!raw.includes(hidden), `${hidden} must not reach a driver who does not hold it`);
    }
    // A withdrawn service disappears, a driver with nothing sees an empty list.
    assert.deepStrictEqual((await api("/api/drivers/tiers", { as: d2 })).body.tiers, []);
  });

  await test("a driver cannot ask for a service from the app, nothing is recorded", async () => {
    const before = (await pool.query("SELECT count(*)::int n FROM driver_tier_access WHERE driver_id = $1 AND status = 'requested'", [d2.driverId])).rows[0].n;
    const r = await api("/api/drivers/tiers/request", { method: "POST", as: d2, body: { tier: "air" } });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.body.code, "tier_request_closed");
    const after = (await pool.query("SELECT count(*)::int n FROM driver_tier_access WHERE driver_id = $1 AND status = 'requested'", [d2.driverId])).rows[0].n;
    assert.strictEqual(after, before);
    assert.deepStrictEqual((await api("/api/drivers/tiers", { as: d2 })).body.active, []);
  });

  await test("a driver with no tier cannot go online, one with a tier can", async () => {
    const none = await mkDriver("No Tier");
    const r = await api("/api/drivers/status", { method: "PATCH", as: none, body: { isOnline: true } });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.body.code, "NO_TIER");
    const withTier = await api("/api/drivers/status", { method: "PATCH", as: d1, body: { isOnline: true } });
    assert.notStrictEqual(withTier.body.code, "NO_TIER");
    assert.notStrictEqual(withTier.status, 403, JSON.stringify(withTier.body));
  });

  await test("the ride queue and accept follow the tier: airport rides need ride, charters need chauffeur", async () => {
    const airport = await mkRide("one_way");
    const charter = await mkRide("full_day");
    // d1 holds ride + express, not chauffeur.
    const q1 = await api("/api/rides/available", { as: d1 });
    const ids1 = q1.body.rides.map((x) => x.id);
    assert.ok(ids1.includes(airport), "ride tier sees airport rides");
    assert.ok(!ids1.includes(charter), "no chauffeur tier, no charters");
    const denied = await api(`/api/rides/${charter}/accept`, { method: "POST", as: d1 });
    assert.strictEqual(denied.status, 403);
    assert.strictEqual(denied.body.code, "TIER_NOT_GRANTED");
    assert.strictEqual(denied.body.tier, "chauffeur");
    // d2 holds nothing active.
    const q2 = await api("/api/rides/available", { as: d2 });
    assert.deepStrictEqual(q2.body.rides.filter((x) => [airport, charter].includes(x.id)), []);
    assert.strictEqual((await api(`/api/rides/${airport}/accept`, { method: "POST", as: d2 })).status, 403);
    // Granting chauffeur opens exactly that.
    await grant(owner, d1.driverId, "chauffeur");
    assert.ok((await api("/api/rides/available", { as: d1 })).body.rides.some((x) => x.id === charter));
    const okAccept = await api(`/api/rides/${charter}/accept`, { method: "POST", as: d1 });
    assert.notStrictEqual(okAccept.status, 403, JSON.stringify(okAccept.body));
    // And withdrawing closes it for the next charter.
    const charter2 = await mkRide("full_week");
    await revoke(owner, d1.driverId, "chauffeur", "Paused");
    assert.ok(!(await api("/api/rides/available", { as: d1 })).body.rides.some((x) => x.id === charter2));
  });

  await test("ArrivoExpress is isolated: no tier, no opt-in, no offers, no accept", async () => {
    const e = await mkDriver("No Express");
    await grant(owner, e.driverId, "ride");
    const opt = await api("/api/instant-rides/driver/availability", { method: "PATCH", as: e, body: { acceptsInstant: true } });
    assert.strictEqual(opt.status, 403);
    assert.strictEqual(opt.body.code, "TIER_NOT_GRANTED");
    const offers = await api("/api/instant-rides/driver/offers", { as: e });
    assert.deepStrictEqual(offers.body.offers, []);
    assert.strictEqual(offers.body.tierNotGranted, true);
    assert.strictEqual((await api("/api/instant-rides/driver/offers/1/accept", { method: "POST", as: e })).status, 403);
    // With the tier on, opting in works.
    const okOpt = await api("/api/instant-rides/driver/availability", { method: "PATCH", as: d1, body: { acceptsInstant: true } });
    assert.strictEqual(okOpt.status, 200, JSON.stringify(okOpt.body));
    // Dispatch only draws from drivers who hold express. Two fresh drivers with a car each, both online and opted in.
    const holder = await mkDriver("Has Express");
    await grant(owner, holder.driverId, "express");
    for (const x of [holder, e]) {
      const v = (await pool.query("INSERT INTO vehicles (owner_user_id, make_model, plate_number, vehicle_type, seats) VALUES ($1, 'Toyota Camry', $2, 'sedan', 4) RETURNING id", [x.id, `TST${x.driverId}${stamp % 1000}`])).rows[0].id;
      await pool.query("UPDATE drivers SET vehicle_id = $2, is_online = true, accepts_instant = true, current_lat = 6.5, current_lng = 3.3, location_updated_at = now() WHERE id = $1", [x.driverId, v]);
    }
    const { findEligibleDrivers } = require("../services/instantDispatch");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const found = await findEligibleDrivers(client, { requestId: 0, pickupLat: 6.5, pickupLng: 3.3, radiusKm: 50, batchSize: 50, vehicleType: null, minSeats: 1 });
      await client.query("ROLLBACK");
      const ids = found.map((r) => r.driver_id || r.id);
      assert.ok(ids.includes(holder.driverId), "a driver who holds express is offered it (" + JSON.stringify(found.map((r) => Object.keys(r).slice(0, 4))) + ")");
      assert.ok(!ids.includes(e.driverId), "a driver without express is never offered an express ride");
    } finally { client.release(); }
  });

  await test("existing drivers are carried over once at rollout, a restart changes nothing", async () => {
    const sql = fs.readFileSync(path.join(__dirname, "..", "db", "schema.sql"), "utf8");
    const block = sql.slice(sql.indexOf("DO $$\nBEGIN\n  IF NOT EXISTS (SELECT 1 FROM system_config WHERE key = 'driver_tier_backfill_done')"));
    const t = createDriverTiers(pool);
    // Put the database back to "before the rollout" for one legacy driver.
    const old = await mkDriver("Legacy Driver");
    await pool.query("DELETE FROM driver_tier_access WHERE driver_id = $1", [old.driverId]);
    await pool.query("UPDATE drivers SET tier = 'air' WHERE id = $1", [old.driverId]);
    await pool.query("DELETE FROM system_config WHERE key = 'driver_tier_backfill_done'");
    await pool.query(block);
    assert.deepStrictEqual((await t.activeSlugs(old.driverId)).sort(), ["air", "chauffeur", "express", "ride"]);
    // A withdrawal after the rollout survives the next restart.
    await t.revoke({ driverId: old.driverId, tier: "express", actorId: owner.id, note: "Pulled" });
    await pool.query(block);
    assert.ok(!(await t.activeSlugs(old.driverId)).includes("express"));
    // A driver who signs up after the rollout is never switched on by a restart.
    const fresh = await mkDriver("Fresh Driver");
    await pool.query(block);
    assert.deepStrictEqual(await t.activeSlugs(fresh.driverId), []);
  });

  // Cleanup (users cascade to drivers/rides where the schema says so; ignore the rest).
  try {
    await pool.query("DELETE FROM rides WHERE rider_id = ANY($1) OR driver_id IN (SELECT id FROM drivers WHERE user_id = ANY($1))", [madeUsers]);
    await pool.query("DELETE FROM instant_ride_offers WHERE driver_id IN (SELECT id FROM drivers WHERE user_id = ANY($1))", [madeUsers]).catch(() => {});
    await pool.query("DELETE FROM drivers WHERE user_id = ANY($1)", [madeUsers]);
    await pool.query("DELETE FROM staff_role_events WHERE actor_id = ANY($1) OR target_id = ANY($1)", [madeUsers]).catch(() => {});
    await pool.query("DELETE FROM users WHERE id = ANY($1)", [madeUsers]);
  } catch (_) { /* a throwaway database, leftovers are harmless */ }
  server.close();
  console.log(`\n${passed} passed${process.exitCode ? ", with failures" : ""}`);
  await pool.end();
})();
