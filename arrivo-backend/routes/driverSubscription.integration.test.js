// Driver daily subscription against a REAL Postgres and the real routes.
//   DATABASE_URL=postgres://... node routes/driverSubscription.integration.test.js
//
// Paystack is stubbed (axios.get) so no network is touched. What is checked:
// only a real, successful, exactly 2,000 naira payment activates a day; a
// replay or double tap never makes a second day; an unsubscribed driver gets
// no orders (queue, accept, go online, ArrivoExpress dispatch) and a
// subscribed one does; the dashboard numbers are the driver's own, for today.

const assert = require("assert");
const http = require("http");
const jwt = require("jsonwebtoken");
const axios = require("axios");

process.env.JWT_SECRET = process.env.JWT_SECRET || "integration-test-secret";
process.env.PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || "sk_test_x";
delete process.env.DRIVER_SUBSCRIPTION_ENFORCED;

const express = require("express");
require("express-async-errors");
const { pool } = require("../db/db");

let passed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.log(`FAIL  ${name}\n      ${e.stack.split("\n").slice(0, 3).join("\n      ")}`); process.exitCode = 1; }
}

// Stub Paystack: the reference decides what it "returns".
//   ok-2000-*  success 2000 NGN   ok-1000-* success 1000   usd-* USD   fail-* failed   boom-* network error
const paystackCalls = [];
axios.get = async (url) => {
  const ref = decodeURIComponent(url.split("/verify/")[1]);
  paystackCalls.push(ref);
  if (ref.startsWith("boom")) throw new Error("network down");
  const data = { reference: ref, currency: "NGN", status: "success", amount: 200000 };
  if (ref.startsWith("ok1000")) data.amount = 100000;
  if (ref.startsWith("usd")) data.currency = "USD";
  if (ref.startsWith("fail")) data.status = "failed";
  return { data: { data } };
};

const app = express();
app.use(express.json());
app.use("/api/driver-subscription", require("./driverSubscription"));
app.use("/api/drivers", require("./drivers").router);
app.use("/api/rides", require("./rides"));
app.use("/api/admin", require("./admin"));
app.use((err, req, res, next) => res.status(500).json({ error: "server error", detail: err.message }));
const server = http.createServer(app);

async function api(path, { method = "GET", as, body } = {}) {
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/api${path}`, {
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
async function mkUser(role, { verified = true } = {}) {
  seq++;
  const r = await pool.query(
    "INSERT INTO users (name, email, phone, password_hash, role) VALUES ($1,$2,$3,'x',$4) RETURNING id",
    [`${role} Person${seq} Surname`, `sub-${role}-${seq}-${stamp}@example.com`, "+2348100000000", role]
  );
  const id = r.rows[0].id;
  madeUsers.push(id);
  const u = { id, role, token: jwt.sign({ id, email: `u${id}@example.com`, role, tv: 0 }, process.env.JWT_SECRET, { algorithm: "HS256" }) };
  if (role === "driver") {
    const d = await pool.query("INSERT INTO drivers (user_id, is_verified) VALUES ($1, $2) RETURNING id", [id, verified]);
    u.driverId = d.rows[0].id;
  }
  return u;
}
const ref = (p) => `${p}-${stamp}-${++seq}`;
const subRows = (driverId) => pool.query("SELECT * FROM driver_subscription_days WHERE driver_id = $1", [driverId]).then((r) => r.rows);

(async () => {
  await new Promise((r) => server.listen(0, r));

  await test("dashboard needs a driver login", async () => {
    assert.equal((await api("/driver-subscription/dashboard")).status, 401);
    const rider = await mkUser("rider");
    assert.equal((await api("/driver-subscription/dashboard", { as: rider })).status, 403);
  });

  await test("new driver is unsubscribed with the price and no inspection on record", async () => {
    const d = await mkUser("driver");
    const r = await api("/driver-subscription/dashboard", { as: d });
    assert.equal(r.status, 200);
    assert.equal(r.body.subscription.active, false);
    assert.equal(r.body.subscription.priceNaira, 2000);
    assert.equal(r.body.subscription.endsAt, null);
    assert.equal(r.body.today.trips, 0);
    assert.equal(r.body.today.earningsNaira, 0);
    assert.equal(r.body.inspection.state, "not_recorded");
    assert.equal(r.body.inspection.severity, "red");
    assert.equal(r.body.profile.name.startsWith("driver Person"), true);
  });

  await test("verify rejects missing, malformed and path-like references before calling Paystack", async () => {
    const d = await mkUser("driver");
    const before = paystackCalls.length;
    assert.equal((await api("/driver-subscription/verify", { method: "POST", as: d, body: {} })).status, 400);
    assert.equal((await api("/driver-subscription/verify", { method: "POST", as: d, body: { reference: "../123456" } })).status, 400);
    assert.equal((await api("/driver-subscription/verify", { method: "POST", as: d, body: { reference: "a b" } })).status, 400);
    assert.equal(paystackCalls.length, before);
  });

  await test("wrong amount, wrong currency, failed and unreachable payments never subscribe", async () => {
    const d = await mkUser("driver");
    for (const [prefix, status] of [["ok1000", 400], ["usd", 400], ["fail", 400], ["boom", 502]]) {
      const r = await api("/driver-subscription/verify", { method: "POST", as: d, body: { reference: ref(prefix) } });
      assert.equal(r.status, status, prefix);
    }
    assert.equal((await subRows(d.driverId)).length, 0);
  });

  await test("a 2,000 naira payment activates today and ends at Lagos midnight", async () => {
    const d = await mkUser("driver");
    const r = await api("/driver-subscription/verify", { method: "POST", as: d, body: { reference: ref("ok2000") } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.subscription.active, true);
    const end = new Date(r.body.subscription.endsAt);
    assert.equal(end.getUTCMinutes(), 0);
    assert.equal(end.getUTCHours(), 23); // 00:00 Lagos = 23:00 UTC
    assert.ok(end > new Date() && end - new Date() <= 24 * 3600 * 1000);
    const rows = await subRows(d.driverId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].amount_naira, 2000);
    const dash = await api("/driver-subscription/dashboard", { as: d });
    assert.equal(dash.body.subscription.active, true);
  });

  await test("replaying the same reference changes nothing", async () => {
    const d = await mkUser("driver");
    const reference = ref("ok2000");
    assert.equal((await api("/driver-subscription/verify", { method: "POST", as: d, body: { reference } })).status, 200);
    const again = await api("/driver-subscription/verify", { method: "POST", as: d, body: { reference } });
    assert.equal(again.status, 200);
    assert.equal(again.body.alreadyApplied, true);
    assert.equal((await subRows(d.driverId)).length, 1);
  });

  await test("another driver cannot use a reference that already paid for someone else", async () => {
    const a = await mkUser("driver");
    const b = await mkUser("driver");
    const reference = ref("ok2000");
    assert.equal((await api("/driver-subscription/verify", { method: "POST", as: a, body: { reference } })).status, 200);
    const r = await api("/driver-subscription/verify", { method: "POST", as: b, body: { reference } });
    assert.notEqual(r.status, 200);
    assert.equal((await subRows(b.driverId)).length, 0);
  });

  await test("a second payment for the same day is refused and not applied", async () => {
    const d = await mkUser("driver");
    assert.equal((await api("/driver-subscription/verify", { method: "POST", as: d, body: { reference: ref("ok2000") } })).status, 200);
    const second = ref("ok2000");
    const r = await api("/driver-subscription/verify", { method: "POST", as: d, body: { reference: second } });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, "ALREADY_SUBSCRIBED");
    assert.equal((await subRows(d.driverId)).length, 1);
    const claimed = await pool.query("SELECT 1 FROM used_payment_references WHERE reference = $1", [second]);
    assert.equal(claimed.rows.length, 0);
  });

  await test("five parallel taps with different references make exactly one day", async () => {
    const d = await mkUser("driver");
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map(() => api("/driver-subscription/verify", { method: "POST", as: d, body: { reference: ref("ok2000") } }))
    );
    assert.equal(results.filter((r) => r.status === 200).length, 1, results.map((r) => r.status).join(","));
    assert.equal((await subRows(d.driverId)).length, 1);
  });

  await test("yesterday's subscription does not count today", async () => {
    const d = await mkUser("driver");
    await pool.query(
      "INSERT INTO driver_subscription_days (driver_id, day, amount_naira, paystack_reference) VALUES ($1, (now() AT TIME ZONE 'Africa/Lagos')::date - 1, 2000, $2)",
      [d.driverId, ref("old")]
    );
    const dash = await api("/driver-subscription/dashboard", { as: d });
    assert.equal(dash.body.subscription.active, false);
  });

  await test("unsubscribed driver cannot go online; subscribed driver can pass the subscription gate", async () => {
    const d = await mkUser("driver");
    const off = await api("/drivers/status", { method: "PATCH", as: d, body: { isOnline: true } });
    assert.equal(off.status, 402);
    assert.equal(off.body.code, "SUBSCRIPTION_REQUIRED");
    // Going offline is never blocked.
    assert.equal((await api("/drivers/status", { method: "PATCH", as: d, body: { isOnline: false } })).status, 200);
    await api("/driver-subscription/verify", { method: "POST", as: d, body: { reference: ref("ok2000") } });
    const on = await api("/drivers/status", { method: "PATCH", as: d, body: { isOnline: true } });
    assert.notEqual(on.body.code, "SUBSCRIPTION_REQUIRED");
  });

  await test("unsubscribed driver gets an empty queue that says why, and cannot accept", async () => {
    const d = await mkUser("driver");
    const q = await api("/rides/available", { as: d });
    assert.equal(q.status, 200);
    assert.deepEqual(q.body.rides, []);
    assert.equal(q.body.subscriptionRequired, true);
    assert.equal(q.body.code, "SUBSCRIPTION_REQUIRED");
    const acc = await api("/rides/999999/accept", { method: "POST", as: d, body: {} });
    assert.equal(acc.status, 402);
    assert.equal(acc.body.code, "SUBSCRIPTION_REQUIRED");
  });

  await test("subscribed driver's queue is not blocked", async () => {
    const d = await mkUser("driver");
    await api("/driver-subscription/verify", { method: "POST", as: d, body: { reference: ref("ok2000") } });
    const q = await api("/rides/available", { as: d });
    assert.equal(q.status, 200);
    assert.notEqual(q.body.subscriptionRequired, true);
  });

  await test("ArrivoExpress dispatch only finds subscribed drivers", async () => {
    const { findEligibleDrivers } = require("../services/instantDispatch");
    const veh = async (userId) => (await pool.query(
      "INSERT INTO vehicles (owner_user_id, make_model, plate_number, vehicle_type, seats) VALUES ($1,'Toyota Camry',$2,'sedan',4) RETURNING id",
      [userId, `T${stamp % 100000}${userId}`])).rows[0].id;
    const sub = await mkUser("driver");
    const unsub = await mkUser("driver");
    for (const d of [sub, unsub]) {
      const vid = await veh(d.id);
      await pool.query(
        `UPDATE drivers SET vehicle_id = $1, is_online = true, accepts_instant = true,
           current_lat = 6.5244, current_lng = 3.3792, location_updated_at = now() WHERE id = $2`,
        [vid, d.driverId]
      );
    }
    await api("/driver-subscription/verify", { method: "POST", as: sub, body: { reference: ref("ok2000") } });
    const found = await findEligibleDrivers(pool, { requestId: 0, pickupLat: 6.5244, pickupLng: 3.3792, vehicleType: null, minSeats: 1, radiusKm: 50, batchSize: 500 });
    const ids = found.map((r) => r.driver_id);
    assert.ok(ids.includes(sub.driverId), "subscribed driver should be offered");
    assert.ok(!ids.includes(unsub.driverId), "unsubscribed driver must not be offered");
  });

  await test("switching enforcement off lets everyone through (kill switch)", async () => {
    process.env.DRIVER_SUBSCRIPTION_ENFORCED = "false";
    try {
      const d = await mkUser("driver");
      const q = await api("/rides/available", { as: d });
      assert.notEqual(q.body.subscriptionRequired, true);
    } finally {
      delete process.env.DRIVER_SUBSCRIPTION_ENFORCED;
    }
  });

  await test("dashboard shows only this driver's trips and earnings for today", async () => {
    const d = await mkUser("driver");
    const other = await mkUser("driver");
    const rider = await mkUser("rider");
    const mk = (driverId, fare, tip, doneAt) => pool.query(
      `INSERT INTO rides (rider_id, driver_id, pickup_address, ride_status, fare_naira, tip_naira, completed_at)
       VALUES ($1,$2,'A','completed',$3,$4,$5)`, [rider.id, driverId, fare, tip, doneAt]);
    await mk(d.driverId, 10000, 500, new Date());
    await mk(d.driverId, 5000, 0, new Date());
    await mk(d.driverId, 99999, 0, new Date(Date.now() - 2 * 24 * 3600 * 1000)); // not today
    await mk(other.driverId, 7777, 0, new Date());
    const r = await api("/driver-subscription/dashboard", { as: d });
    assert.equal(r.body.today.trips, 2);
    assert.equal(r.body.today.earningsNaira, 15500);
  });

  await test("admin records an inspection; support and riders cannot", async () => {
    const d = await mkUser("driver");
    const admin = await mkUser("admin");
    const support = await mkUser("support");
    assert.equal((await api(`/admin/drivers/${d.driverId}/inspection`, { method: "PATCH", as: support, body: {} })).status, 403);
    assert.equal((await api(`/admin/drivers/${d.driverId}/inspection`, { method: "PATCH", as: d, body: {} })).status, 403);
    assert.equal((await api(`/admin/drivers/${d.driverId}/inspection`, { method: "PATCH", as: admin, body: { inspectedOn: "2999-01-01" } })).status, 400);
    assert.equal((await api(`/admin/drivers/${d.driverId}/inspection`, { method: "PATCH", as: admin, body: { inspectedOn: "not-a-date" } })).status, 400);
    assert.equal((await api(`/admin/drivers/99999999/inspection`, { method: "PATCH", as: admin, body: {} })).status, 404);
    const ok = await api(`/admin/drivers/${d.driverId}/inspection`, { method: "PATCH", as: admin, body: {} });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.body.inspection.state, "ok");
    const dash = await api("/driver-subscription/dashboard", { as: d });
    assert.equal(dash.body.inspection.state, "ok");
    assert.equal(dash.body.inspection.severity, "none");
  });

  await test("the red reminder starts 7 days before the quarterly due date", async () => {
    const d = await mkUser("driver");
    const admin = await mkUser("admin");
    const { addMonths, lagosDay } = require("../services/driverSubscription");
    // Last inspected so that it is due in 7 days, then in 8 days.
    const dueIn = (n) => {
      const t = new Date(Date.parse(`${lagosDay()}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
      return addMonths(t, -3);
    };
    for (const [n, state, sev] of [[8, "ok", "none"], [7, "due_soon", "red"], [0, "due_today", "red"], [-3, "overdue", "red"]]) {
      const day = dueIn(n);
      // addMonths clamping can shift the due date by a day or two at month ends.
      const set = await api(`/admin/drivers/${d.driverId}/inspection`, { method: "PATCH", as: admin, body: { inspectedOn: day } });
      assert.equal(set.status, 200, set.text);
      const got = (await api("/driver-subscription/dashboard", { as: d })).body.inspection;
      if (got.daysLeft === n) { assert.equal(got.state, state); assert.equal(got.severity, sev); }
    }
  });

  // cleanup
  await pool.query("DELETE FROM rides WHERE rider_id = ANY($1) OR driver_id IN (SELECT id FROM drivers WHERE user_id = ANY($1))", [madeUsers]);
  await pool.query("DELETE FROM driver_subscription_days WHERE driver_id IN (SELECT id FROM drivers WHERE user_id = ANY($1))", [madeUsers]);
  await pool.query("DELETE FROM used_payment_references WHERE used_for = 'driver_subscription' AND reference LIKE ANY(ARRAY['ok2000-%','old-%'])");
  await pool.query("DELETE FROM drivers WHERE user_id = ANY($1)", [madeUsers]);
  await pool.query("DELETE FROM vehicles WHERE owner_user_id = ANY($1)", [madeUsers]);
  await pool.query("DELETE FROM users WHERE id = ANY($1)", [madeUsers]);
  server.close();
  await pool.end();
  console.log(`\n${passed} passed${process.exitCode ? ", with failures" : ""}`);
})().catch((e) => { console.error(e); process.exit(1); });
