// Against a REAL Postgres: rider welfare check, trip receipt, and the audit
// trail for a staff assignment that skips a driver's tier. PArAsYtE
const assert = require("assert");
const http = require("http");
const jwt = require("jsonwebtoken");

process.env.JWT_SECRET = process.env.JWT_SECRET || "integration-test-secret";
delete process.env.OPS_ALERT_EMAILS; delete process.env.OPS_ALERT_WHATSAPP;

const express = require("express");
require("express-async-errors");
const { pool, ready } = require("../db/db");

let passed = 0;
const test = (name, fn) => (async () => {
  try { await fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.log(`FAIL  ${name}\n      ${e.stack || e.message}`); process.exitCode = 1; }
})();

const app = express();
app.use(express.json());
app.use("/api/admin", require("./admin"));
app.use("/api/safety", require("./safety"));
app.use("/api/rides", require("./rides"));
app.use((err, req, res, next) => res.status(500).json({ error: "server error", detail: err.message }));
const server = http.createServer(app);
async function call(method, path, token, body) {
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const made = { users: [], rides: [], drivers: [], vehicles: [] };
const stamp = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
async function makeUser(role, name) {
  const r = await pool.query("INSERT INTO users (name, email, password_hash, role, agreed_to_terms) VALUES ($1,$2,'x',$3,true) RETURNING *", [name, `wr-${stamp()}@example.com`, role]);
  made.users.push(r.rows[0].id);
  return r.rows[0];
}
const tokenFor = (u) => jwt.sign({ id: u.id, email: u.email, role: u.role }, process.env.JWT_SECRET);
async function makeDriver(name) {
  const user = await makeUser("driver", name);
  const v = await pool.query("INSERT INTO vehicles (owner_user_id, make_model, plate_number) VALUES ($1,'Toyota Camry','LND123') RETURNING id", [user.id]);
  made.vehicles.push(v.rows[0].id);
  const d = await pool.query("INSERT INTO drivers (user_id, vehicle_id, is_verified) VALUES ($1,$2,true) RETURNING *", [user.id, v.rows[0].id]);
  made.drivers.push(d.rows[0].id);
  return { user, driver: d.rows[0], token: tokenFor(user) };
}
async function makeRide(rider, drv, fields = {}) {
  const f = { ride_status: "in_progress", booking_type: "one_way", fare_naira: 8000, ...fields };
  const r = await pool.query(
    `INSERT INTO rides (rider_id, driver_id, pickup_address, fare_naira, ride_status, booking_type, tip_naira, overage_naira, overage_reason, completed_at, tracking_started_at, payment_status, promo_discount_naira, promo_code)
     VALUES ($1,$2,'Ikeja',$3,$4,$5,$6,$7,$8,$9,$10,'paid',$11,$12) RETURNING *`,
    [rider.id, drv ? drv.driver.id : null, f.fare_naira, f.ride_status, f.booking_type, f.tip_naira || 0, f.overage_naira || 0, f.overage_reason || null,
     f.completed_at || null, f.tracking_started_at || new Date(Date.now() - 60 * 60000), f.promo || 0, f.promo_code || null]);
  made.rides.push(r.rows[0].id);
  return r.rows[0];
}
const P = { lat: 6.5244, lng: 3.3792, accuracy: 10 };

(async () => {
  await ready;
  await new Promise((r) => server.listen(0, r));
  const rider = await makeUser("rider", "Ada Rider"), other = await makeUser("rider", "Other Rider"), admin = await makeUser("admin", "Ops Admin");
  const drv = await makeDriver("Dayo Driver");
  const rt = tokenFor(rider);

  await test("welfare: only the rider of an in-progress trip is watched", async () => {
    const ride = await makeRide(rider, drv);
    assert.equal((await call("POST", `/api/safety/rides/${ride.id}/welfare/ping`, tokenFor(other), P)).status, 404);
    assert.equal((await call("POST", `/api/safety/rides/${ride.id}/welfare/ping`, drv.token, P)).status, 403);
    const ok = await call("POST", `/api/safety/rides/${ride.id}/welfare/ping`, rt, P);
    assert.equal(ok.status, 200); assert.equal(ok.body.watching, true); assert.equal(ok.body.ask, false);
    const done = await makeRide(rider, drv, { ride_status: "completed" });
    assert.equal((await call("POST", `/api/safety/rides/${done.id}/welfare/ping`, rt, P)).body.watching, false);
    assert.equal((await call("POST", `/api/safety/rides/${ride.id}/welfare/ping`, rt, { lat: "x", lng: 1 })).status, 400);
  });

  await test("welfare: stationary 5 minutes asks, yes resets and doubles, silence raises ops alert", async () => {
    const ride = await makeRide(rider, drv);
    const url = `/api/safety/rides/${ride.id}/welfare`;
    await call("POST", `${url}/ping`, rt, P);
    // Age the anchor and last ping as if 5 minutes passed with steady pings.
    const age = (mins, askedMins) => pool.query(
      `UPDATE ride_welfare SET anchor_at = now() - ($2 || ' minutes')::interval, last_ping_at = now() - interval '20 seconds',
              asked_at = CASE WHEN $3::numeric IS NULL THEN NULL ELSE now() - ($3 || ' minutes')::interval END WHERE ride_id = $1`, [ride.id, String(mins), askedMins]);
    await age(5.1, null);
    const asked = await call("POST", `${url}/ping`, rt, P);
    assert.equal(asked.body.ask, true); assert.ok(asked.body.answerWithinSeconds > 100);
    const yes = await call("POST", `${url}/answer`, rt, { safe: true });
    assert.equal(yes.body.ask, false);
    assert.equal((await pool.query("SELECT multiplier FROM ride_welfare WHERE ride_id = $1", [ride.id])).rows[0].multiplier, 2);
    assert.equal((await pool.query("SELECT panic_triggered_at FROM rides WHERE id = $1", [ride.id])).rows[0].panic_triggered_at, null);

    await age(11, null); await call("POST", `${url}/ping`, rt, P);          // asks again after the doubled wait
    await age(11, 2.5);                                                      // asked 2.5 minutes ago, no answer
    const late = await call("POST", `${url}/ping`, rt, P);
    assert.equal(late.body.raised, true);
    const after = (await pool.query("SELECT panic_triggered_at, panic_notes, listening_device_activated_at FROM rides WHERE id = $1", [ride.id])).rows[0];
    assert.ok(after.panic_triggered_at); assert.match(after.panic_notes, /Welfare check/);
    assert.equal(after.listening_device_activated_at, null);
    assert.equal((await pool.query("SELECT count(*)::int n FROM safety_events WHERE kind = 'welfare_raised' AND ride_id = $1", [ride.id])).rows[0].n, 1);
    await call("POST", `${url}/ping`, rt, P);                                // a second ping must not raise twice
    assert.equal((await pool.query("SELECT count(*)::int n FROM safety_events WHERE kind = 'welfare_raised' AND ride_id = $1", [ride.id])).rows[0].n, 1);
  });

  await test("welfare: answering no raises at once", async () => {
    const ride = await makeRide(rider, drv); const url = `/api/safety/rides/${ride.id}/welfare`;
    await call("POST", `${url}/ping`, rt, P);
    await pool.query("UPDATE ride_welfare SET anchor_at = now() - interval '6 minutes', last_ping_at = now() - interval '20 seconds' WHERE ride_id = $1", [ride.id]);
    assert.equal((await call("POST", `${url}/ping`, rt, P)).body.ask, true);
    assert.equal((await call("POST", `${url}/answer`, rt, { safe: false })).body.raised, true);
    assert.equal((await call("POST", `${url}/answer`, rt, { safe: "maybe" })).status, 400);
  });

  await test("welfare: the sweep raises an unanswered question when no more pings arrive", async () => {
    const { welfareCheck } = require("../services/welfareRuntime");
    const ride = await makeRide(rider, drv); const url = `/api/safety/rides/${ride.id}/welfare`;
    await call("POST", `${url}/ping`, rt, P);
    await pool.query("UPDATE ride_welfare SET anchor_at = now() - interval '6 minutes', last_ping_at = now() - interval '20 seconds' WHERE ride_id = $1", [ride.id]);
    assert.equal((await call("POST", `${url}/ping`, rt, P)).body.ask, true);
    assert.equal(await welfareCheck.sweepOverdue(), 0, "not overdue yet");
    await pool.query("UPDATE ride_welfare SET asked_at = now() - interval '3 minutes' WHERE ride_id = $1", [ride.id]);
    assert.ok((await welfareCheck.sweepOverdue()) >= 1);
    assert.equal((await pool.query("SELECT status FROM ride_welfare WHERE ride_id = $1", [ride.id])).rows[0].status, "raised");
    assert.ok((await pool.query("SELECT panic_triggered_at FROM rides WHERE id = $1", [ride.id])).rows[0].panic_triggered_at);
    assert.equal(await welfareCheck.sweepOverdue(), 0, "never raises twice");
  });

  await test("receipt: rider and driver, each sees the other's name; totals add up", async () => {
    const ride = await makeRide(rider, drv, { ride_status: "completed", completed_at: new Date(), fare_naira: 9000, tip_naira: 500, overage_naira: 1500, overage_reason: "traffic_delay", promo: 1000, promo_code: "LAUNCH" });
    const r = await call("GET", `/api/rides/${ride.id}/receipt`, rt);
    assert.equal(r.status, 200);
    assert.equal(r.body.receipt.totalNaira, 11000);
    assert.deepEqual(r.body.receipt.lines.map((l) => l.label), ["Fare", "Traffic delay", "Tip"]);
    assert.equal(r.body.receipt.promo.savedNaira, 1000);
    assert.equal(r.body.receipt.driver.name, "Dayo Driver"); assert.equal(r.body.receipt.driver.plate, "LND123"); assert.equal(r.body.receipt.rider, null);
    const d = await call("GET", `/api/rides/${ride.id}/receipt`, drv.token);
    assert.equal(d.body.receipt.rider.name, "Ada Rider"); assert.equal(d.body.receipt.driver, null);
    assert.equal(r.body.receipt.service, "ride");
    const chauffeur = await makeRide(rider, drv, { ride_status: "completed", completed_at: new Date(), booking_type: "full_day" });
    assert.equal((await call("GET", `/api/rides/${chauffeur.id}/receipt`, rt)).body.receipt.service, "chauffeur");
  });

  await test("receipt: strangers get 404, unfinished trips 409", async () => {
    const done = await makeRide(rider, drv, { ride_status: "completed", completed_at: new Date() });
    assert.equal((await call("GET", `/api/rides/${done.id}/receipt`, tokenFor(other))).status, 404);
    const live = await makeRide(rider, drv);
    assert.equal((await call("GET", `/api/rides/${live.id}/receipt`, rt)).status, 409);
    assert.equal((await call("GET", `/api/rides/abc/receipt`, rt)).status, 400);
  });

  await test("staff assignment: works for a driver without the tier, and leaves a trail", async () => {
    const ride = await makeRide(rider, null, { ride_status: "requested" });
    const res = await call("PATCH", `/api/admin/rides/${ride.id}/driver`, tokenFor(admin), { driverId: drv.driver.id });
    assert.equal(res.status, 200); assert.equal(res.body.ride.driver_id, drv.driver.id);
    assert.match(res.body.tierNote, /does not hold the ride service/);
    assert.equal((await pool.query("SELECT count(*)::int n FROM safety_events WHERE kind = 'manual_assignment_without_tier' AND ride_id = $1", [ride.id])).rows[0].n, 1);
    await pool.query("INSERT INTO driver_tier_access (driver_id, tier, status) VALUES ($1,'ride','active') ON CONFLICT (driver_id, tier) DO UPDATE SET status = 'active'", [drv.driver.id]);
    const r2 = await makeRide(rider, null, { ride_status: "requested" });
    const ok = await call("PATCH", `/api/admin/rides/${r2.id}/driver`, tokenFor(admin), { driverId: drv.driver.id });
    assert.equal(ok.body.tierNote, null);
  });

  // cleanup
  await pool.query("DELETE FROM safety_events WHERE ride_id = ANY($1::int[])", [made.rides]).catch(() => {});
  await pool.query("DELETE FROM rides WHERE id = ANY($1::int[])", [made.rides]).catch(() => {});
  await pool.query("DELETE FROM driver_tier_access WHERE driver_id = ANY($1::int[])", [made.drivers]).catch(() => {});
  await pool.query("DELETE FROM drivers WHERE id = ANY($1::int[])", [made.drivers]).catch(() => {});
  await pool.query("DELETE FROM vehicles WHERE id = ANY($1::int[])", [made.vehicles]).catch(() => {});
  await pool.query("DELETE FROM users WHERE id = ANY($1::int[])", [made.users]).catch(() => {});
  server.close();
  console.log(`${passed} passed`);
  await pool.end();
})();
