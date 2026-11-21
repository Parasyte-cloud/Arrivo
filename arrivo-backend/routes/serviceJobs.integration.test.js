// Against a REAL Postgres: Ops-created jobs for Campus, Air, Boat and Removals run the whole
// trip: queue gated by tier, accept, start, "Are you safe?", complete, receipt. PArAsYtE
// These tests are about services and tiers, not the daily subscription.
process.env.DRIVER_SUBSCRIPTION_ENFORCED = "false";
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


const SERVICES = ["campus", "air", "boat", "removals"];

(async () => {
  await ready;
  await new Promise((r) => server.listen(0, r));
  const rider = await makeUser("rider", "Ada Rider"), admin = await makeUser("admin", "Ops Admin");
  const holder = await makeDriver("Holder Driver"), outsider = await makeDriver("Outsider Driver");
  const at = tokenFor(admin), rt = tokenFor(rider);
  const jobs = [];

  await test("ops creates a job only for a real service and a real rider", async () => {
    const good = { service: "boat", riderEmail: rider.email, pickup: "Lekki Marina", destination: "Badagry Jetty", quoteNaira: 150000 };
    assert.equal((await call("POST", "/api/admin/service-jobs", tokenFor(rider), good)).status, 403, "riders cannot");
    assert.equal((await call("POST", "/api/admin/service-jobs", at, { ...good, service: "ride" })).status, 400);
    assert.equal((await call("POST", "/api/admin/service-jobs", at, { ...good, quoteNaira: -5 })).status, 400);
    assert.equal((await call("POST", "/api/admin/service-jobs", at, { ...good, quoteNaira: 1.5 })).status, 400);
    assert.equal((await call("POST", "/api/admin/service-jobs", at, { ...good, riderEmail: "nobody@example.test" })).status, 404);
    assert.equal((await call("POST", "/api/admin/service-jobs", at, { ...good, riderEmail: holder.user.email })).status, 404, "a driver is not a rider");
    assert.equal((await call("POST", "/api/admin/service-jobs", at, { ...good, pickup: "x" })).status, 400);
  });

  for (const service of SERVICES) {
    await test(`${service}: queue is gated by tier, then accept, start, safety check, finish, receipt`, async () => {
      const made1 = await call("POST", "/api/admin/service-jobs", at, { service, riderEmail: rider.email, pickup: "Pickup " + service, destination: "Dest " + service, quoteNaira: 120000, paid: true, notes: "agreed by phone" });
      assert.equal(made1.status, 201, JSON.stringify(made1.body));
      const job = made1.body.ride; made.rides.push(job.id); jobs.push(job.id);
      assert.equal(job.service, service); assert.equal(job.ride_status, "requested"); assert.equal(job.payment_status, "paid");

      const hasJob = async (drv) => (await call("GET", "/api/rides/available", drv.token)).body.rides.some((r) => r.id === job.id);
      await pool.query("INSERT INTO driver_tier_access (driver_id, tier, status) VALUES ($1,$2,'active') ON CONFLICT (driver_id, tier) DO UPDATE SET status='active'", [holder.driver.id, service]);
      assert.equal(await hasJob(outsider), false, "a driver without the service never sees it");
      assert.equal(await hasJob(holder), true, "a driver with the service does");
      const refused = await call("POST", `/api/rides/${job.id}/accept`, outsider.token);
      assert.equal(refused.status, 403); assert.equal(refused.body.code, "TIER_NOT_GRANTED"); assert.equal(refused.body.tier, service);

      assert.equal((await call("POST", `/api/rides/${job.id}/accept`, holder.token)).status, 200);
      assert.equal((await call("PATCH", `/api/rides/${job.id}/status`, holder.token, { status: "in_progress" })).status, 200);

      const url = `/api/safety/rides/${job.id}/welfare`;
      assert.equal((await call("POST", `${url}/ping`, rt, P)).body.watching, true, "the safety check watches this trip");
      await pool.query("UPDATE ride_welfare SET anchor_at = now() - interval '6 minutes', last_ping_at = now() - interval '20 seconds' WHERE ride_id = $1", [job.id]);
      assert.equal((await call("POST", `${url}/ping`, rt, P)).body.ask, true, "and asks 'Are you safe?'");
      assert.equal((await call("POST", `${url}/answer`, rt, { safe: true })).body.ask, false);

      assert.equal((await call("PATCH", `/api/rides/${job.id}/status`, holder.token, { status: "completed" })).status, 200);
      const rr = await call("GET", `/api/rides/${job.id}/receipt`, rt);
      assert.equal(rr.status, 200, JSON.stringify(rr.body));
      assert.equal(rr.body.receipt.service, service); assert.equal(rr.body.receipt.totalNaira, 120000);
      assert.equal(rr.body.receipt.driver.name, "Holder Driver"); assert.equal(rr.body.receipt.paymentMethod, "invoice");
      const dr = await call("GET", `/api/rides/${job.id}/receipt`, holder.token);
      assert.equal(dr.body.receipt.rider.name, "Ada Rider"); assert.equal(dr.body.receipt.service, service);
    });
  }

  await test("staff can still assign any verified driver, and the note names the right service", async () => {
    const m = await call("POST", "/api/admin/service-jobs", at, { service: "removals", riderEmail: rider.email, pickup: "Yaba flat", destination: "Ajah flat", quoteNaira: 300000 });
    made.rides.push(m.body.ride.id);
    const a = await call("PATCH", `/api/admin/rides/${m.body.ride.id}/driver`, at, { driverId: outsider.driver.id });
    assert.equal(a.status, 200); assert.match(a.body.tierNote, /does not hold the removals service/);
  });

  await test("ordinary rides keep their old service", async () => {
    const { tierForRide } = require("../services/driverTiers");
    assert.equal(tierForRide({ booking_type: "one_way" }), "ride");
    assert.equal(tierForRide({ booking_type: "full_day" }), "chauffeur");
    assert.equal(tierForRide({ booking_type: "service_job", service: "air" }), "air");
    assert.equal(tierForRide({ booking_type: "one_way", service: "nonsense" }), "ride");
  });

  await pool.query("DELETE FROM safety_events WHERE ride_id = ANY($1::int[])", [made.rides]).catch(() => {});
  await pool.query("DELETE FROM ride_welfare WHERE ride_id = ANY($1::int[])", [made.rides]).catch(() => {});
  await pool.query("DELETE FROM rides WHERE id = ANY($1::int[])", [made.rides]).catch(() => {});
  await pool.query("DELETE FROM driver_tier_access WHERE driver_id = ANY($1::int[])", [made.drivers]).catch(() => {});
  await pool.query("DELETE FROM drivers WHERE id = ANY($1::int[])", [made.drivers]).catch(() => {});
  await pool.query("DELETE FROM vehicles WHERE id = ANY($1::int[])", [made.vehicles]).catch(() => {});
  await pool.query("DELETE FROM users WHERE id = ANY($1::int[])", [made.users]).catch(() => {});
  server.close();
  console.log(`${passed} passed`);
  await pool.end();
})();
