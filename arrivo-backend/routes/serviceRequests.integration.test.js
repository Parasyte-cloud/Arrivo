// Against a REAL Postgres: a RIDER orders any service; only drivers holding that tier see it;
// the trip cannot start until Ops sets the price. PArAsYtE
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
app.use("/api/service-requests", require("./serviceRequests"));
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
  const rider = await makeUser("rider", "Ada Rider"), rider2 = await makeUser("rider", "Bayo Rider"), admin = await makeUser("admin", "Ops Admin");
  const holder = await makeDriver("Holder Driver"), other = await makeDriver("Other Driver");
  const rt = tokenFor(rider), at = tokenFor(admin);
  const good = (service) => ({ confirmAge16: true, service, pickupAddress: "Pickup " + service, destinationAddress: "Dest " + service, contactPhone: "+2348012345678", passengerCount: 2, details: "two boxes" });

  await test("validation: real service, real addresses, dialable phone, future time, riders only", async () => {
    assert.equal((await call("POST", "/api/service-requests", null, good("boat"))).status, 401);
    assert.equal((await call("POST", "/api/service-requests", rt, good("ride"))).status, 400);
    assert.equal((await call("POST", "/api/service-requests", rt, { ...good("boat"), pickupAddress: "x" })).status, 400);
    assert.equal((await call("POST", "/api/service-requests", rt, { ...good("boat"), contactPhone: "abc" })).status, 400);
    assert.equal((await call("POST", "/api/service-requests", rt, { ...good("boat"), requestedPickupAt: "2020-01-01T10:00:00Z" })).status, 400);
    assert.equal((await call("POST", "/api/service-requests", rt, { ...good("boat"), passengerCount: 0 })).status, 400);
    assert.equal((await call("POST", "/api/service-requests", holder.token, good("boat"))).status, 403, "a driver cannot order");
  });

  for (const service of SERVICES) {
    await test(`${service}: any rider orders it, only tier holders see it, no start until priced`, async () => {
      const r = await call("POST", "/api/service-requests", tokenFor(rider2), good(service));
      assert.equal(r.status, 201, JSON.stringify(r.body));
      const job = r.body.ride; made.rides.push(job.id);
      assert.equal(job.service, service); assert.equal(job.quote_pending, true); assert.equal(job.ride_status, "requested");
      assert.equal((await call("POST", "/api/service-requests", tokenFor(rider2), good(service))).body.duplicate, true, "a double tap is one order");

      const has = async (d) => (await call("GET", "/api/rides/available", d.token)).body.rides.find((x) => x.id === job.id);
      await pool.query("INSERT INTO driver_tier_access (driver_id, tier, status) VALUES ($1,$2,'active') ON CONFLICT (driver_id, tier) DO UPDATE SET status='active'", [holder.driver.id, service]);
      assert.equal(await has(other), undefined, "a driver without the tier never sees it");
      const seen = await has(holder);
      assert.ok(seen, "a driver with the tier does"); assert.equal(seen.quote_pending, true);
      assert.equal((await call("POST", `/api/rides/${job.id}/accept`, other.token)).body.code, "TIER_NOT_GRANTED");
      assert.equal((await call("POST", `/api/rides/${job.id}/accept`, holder.token)).status, 200);

      const early = await call("PATCH", `/api/rides/${job.id}/status`, holder.token, { status: "in_progress" });
      assert.equal(early.status, 409); assert.equal(early.body.code, "QUOTE_PENDING");
      assert.equal((await call("PATCH", `/api/admin/service-jobs/${job.id}/quote`, rt, { quoteNaira: 90000 })).status, 403, "riders cannot price");
      assert.equal((await call("PATCH", `/api/admin/service-jobs/${job.id}/quote`, at, { quoteNaira: 0 })).status, 400);
      const q = await call("PATCH", `/api/admin/service-jobs/${job.id}/quote`, at, { quoteNaira: 90000, paid: true });
      assert.equal(q.status, 200); assert.equal(q.body.ride.quote_pending, false); assert.equal(Number(q.body.ride.fare_naira), 90000);
      assert.equal((await call("PATCH", `/api/rides/${job.id}/status`, holder.token, { status: "in_progress" })).status, 200);
      assert.equal((await call("PATCH", `/api/rides/${job.id}/status`, holder.token, { status: "completed" })).status, 200);
      const rc = await call("GET", `/api/rides/${job.id}/receipt`, tokenFor(rider2));
      assert.equal(rc.body.receipt.service, service); assert.equal(rc.body.receipt.totalNaira, 90000);
    });
  }

  await test("Campus needs the 16+ confirmation; the catalogue lists every service", async () => {
    const no = await call("POST", "/api/service-requests", rt, { ...good("campus"), confirmAge16: false });
    assert.equal(no.status, 400); assert.equal(no.body.code, "CAMPUS_AGE_CONFIRM");
    const yes = await call("POST", "/api/service-requests", rt, good("campus")); made.rides.push(yes.body.ride.id);
    assert.equal(yes.status, 201);
    const cat = await call("GET", "/api/service-requests/catalogue", rt);
    assert.equal(cat.status, 200);
    assert.deepStrictEqual(cat.body.services.map((s) => s.id), ["express", "transfer", "campus", "removals", "chauffeur", "air", "boat"]);
    assert.deepStrictEqual([...new Set(cat.body.services.map((s) => s.group))], ["ride", "move", "charter"]);
    assert.equal(cat.body.services.find((s) => s.id === "campus").minAge, 16);
    process.env.ARRIVO_NOW_ENABLED = "true";
    assert.equal((await call("GET", "/api/service-requests/catalogue", rt)).body.services[0].enabled, true);
    delete process.env.ARRIVO_NOW_ENABLED;
    assert.equal((await call("GET", "/api/service-requests/catalogue", rt)).body.services[0].enabled, false);
  });

  await test("map points: a service job lands on the live map like an Express trip; bad points are ignored, never an error", async () => {
    const mapper = await makeUser("rider", "Map Rider"); const mt = tokenFor(mapper);
    const ok = await call("POST", "/api/service-requests", mt, { ...good("air"), pickupLat: 6.4281, pickupLng: 3.4219, destinationLat: "6.5774", destinationLng: 3.3212 });
    assert.equal(ok.status, 201, JSON.stringify(ok.body)); made.rides.push(ok.body.ride.id);
    const row = (await pool.query("SELECT pickup_lat, pickup_lng, destination_lat, destination_lng FROM rides WHERE id=$1", [ok.body.ride.id])).rows[0];
    assert.equal(Number(row.pickup_lat), 6.4281); assert.equal(Number(row.destination_lng), 3.3212);
    const bad = await call("POST", "/api/service-requests", mt, { ...good("removals"), pickupAddress: "Somewhere else 12", pickupLat: 999, pickupLng: 3.4, destinationLat: "abc", destinationLng: 3.3 });
    assert.equal(bad.status, 201); made.rides.push(bad.body.ride.id);
    const r2 = (await pool.query("SELECT pickup_lat, destination_lat FROM rides WHERE id=$1", [bad.body.ride.id])).rows[0];
    assert.equal(r2.pickup_lat, null); assert.equal(r2.destination_lat, null);
  });

  await test("one account cannot flood Ops: orders are rate limited per user", async () => {
    const flooder = tokenFor(await makeUser("rider", "Flood Rider")); let last = 0;
    for (let i = 0; i < 18; i++) { const r = await call("POST", "/api/service-requests", flooder, { ...good("air"), pickupAddress: "Flood pickup " + i }); if (r.body.ride) made.rides.push(r.body.ride.id); last = r.status; }
    assert.equal(last, 429);
  });

  await test("Ops alert: skipped loudly when nobody is configured, formats and sends when they are", async () => {
    const { sendServiceRequestAlert } = require("../services/serviceRequestAlert");
    const r = await call("POST", "/api/service-requests", rt, good("boat")); made.rides.push(r.body.ride.id);
    assert.deepStrictEqual(await sendServiceRequestAlert(pool, r.body.ride.id), { skipped: true });
    const wa = require("../services/whatsapp"); const sent = []; const orig = wa.sendWhatsAppMessage;
    wa.sendWhatsAppMessage = async (to, text) => { sent.push({ to, text }); return { ok: true }; };
    process.env.OPS_ALERT_WHATSAPP = "+2348000000001";
    delete require.cache[require.resolve("../services/serviceRequestAlert")];
    const out = await require("../services/serviceRequestAlert").sendServiceRequestAlert(pool, r.body.ride.id);
    wa.sendWhatsAppMessage = orig; delete process.env.OPS_ALERT_WHATSAPP;
    assert.equal(out.delivered, 1); assert.equal(sent[0].to, "+2348000000001");
    assert.match(sent[0].text, /NEW BOAT REQUEST #\d+: set the price/); assert.match(sent[0].text, /Pickup boat/);
    assert.equal(await require("../services/serviceRequestAlert").sendServiceRequestAlert(pool, 99999999).then((x) => x.skipped), true);
  });

  await test("a rider's order shows in their own ride history; other riders do not see it", async () => {
    const r = await call("POST", "/api/service-requests", rt, good("campus")); made.rides.push(r.body.ride.id);
    assert.ok((await call("GET", "/api/rides/mine", rt)).body.rides.some((x) => x.id === r.body.ride.id));
    assert.ok(!(await call("GET", "/api/rides/mine", tokenFor(rider2))).body.rides.some((x) => x.id === r.body.ride.id));
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
