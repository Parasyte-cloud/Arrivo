// Against a REAL Postgres: pickup PIN, expiring share links, driver selfie
// check and two-way complaints, through the real routes and gates.

const assert = require("assert");
const http = require("http");
const jwt = require("jsonwebtoken");

process.env.JWT_SECRET = process.env.JWT_SECRET || "integration-test-secret";
process.env.SHARE_LINK_GRACE_MINUTES = "15";
delete process.env.SAFETY_ALERT_EMAIL;

const express = require("express");
require("express-async-errors");
const { pool, ready } = require("../db/db");
const systemConfig = require("../services/systemConfig");
const pickupPin = require("../services/pickupPin");

let passed = 0;
const test = (name, fn) => (async () => {
  try { await fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.log(`FAIL  ${name}\n      ${e.stack || e.message}`); process.exitCode = 1; }
})();

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use("/api/admin/safety", require("./adminSafety"));
app.use("/api/safety", require("./safety"));
app.use("/api/rides", require("./rides"));
app.use("/api/drivers", require("./drivers").router);
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
  const r = await pool.query(
    "INSERT INTO users (name, email, password_hash, role, agreed_to_terms) VALUES ($1,$2,'x',$3,true) RETURNING *",
    [name, `sf-${stamp()}@example.com`, role]);
  made.users.push(r.rows[0].id);
  return r.rows[0];
}
const tokenFor = (u) => jwt.sign({ id: u.id, email: u.email, role: u.role }, process.env.JWT_SECRET);
async function makeDriver(name = "Driver") {
  const user = await makeUser("driver", name);
  const v = await pool.query("INSERT INTO vehicles (owner_user_id, make_model, plate_number) VALUES ($1,'Toyota Camry','LND123') RETURNING id", [user.id]);
  made.vehicles.push(v.rows[0].id);
  const d = await pool.query("INSERT INTO drivers (user_id, vehicle_id, is_verified) VALUES ($1,$2,true) RETURNING *", [user.id, v.rows[0].id]);
  made.drivers.push(d.rows[0].id);
  return { user, driver: d.rows[0], token: tokenFor(user) };
}
async function makeRide(rider, drv, { status = "accepted", express = true } = {}) {
  const r = await pool.query(
    "INSERT INTO rides (rider_id, driver_id, pickup_address, fare_naira, ride_status, payment_status) VALUES ($1,$2,'Ikeja',5000,$3,'paid') RETURNING *",
    [rider.id, drv ? drv.driver.id : null, status]);
  made.rides.push(r.rows[0].id);
  if (express) {
    await pool.query(
      `INSERT INTO instant_ride_requests (rider_id, pickup_address, pickup_lat, pickup_lng, destination_address, destination_lat, destination_lng, status, ride_id, matched_driver_id)
       VALUES ($1,'Ikeja',6.6,3.3,'VI',6.4,3.4,'matched',$2,$3)`, [rider.id, r.rows[0].id, drv ? drv.driver.id : null]);
  }
  return r.rows[0];
}
const sw = (key, on) => systemConfig.setConfig(key, on ? "true" : "false", null);
const png = "data:image/png;base64," + Buffer.from("fakeimagebytes").toString("base64");

(async () => {
  await ready;
  await new Promise((r) => server.listen(0, r));
  await pool.query("DELETE FROM system_config WHERE key IN ('safety_pickup_pin_required','safety_selfie_required')");
  const admin = await makeUser("admin", "Safety Admin");
  const adminToken = tokenFor(admin);

  // ───────────── Pickup PIN ─────────────
  await test("PIN is not enforced while the switch is off", async () => {
    const rider = await makeUser("rider", "R1"); const drv = await makeDriver();
    const ride = await makeRide(rider, drv);
    const res = await call("PATCH", `/api/rides/${ride.id}/status`, drv.token, { status: "in_progress" });
    assert.strictEqual(res.status, 200);
  });

  await sw("safety_pickup_pin_required", true);

  await test("with the switch on, an Express trip cannot start without the PIN", async () => {
    const rider = await makeUser("rider", "R2"); const drv = await makeDriver();
    const ride = await makeRide(rider, drv);
    const res = await call("PATCH", `/api/rides/${ride.id}/status`, drv.token, { status: "in_progress" });
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.code, "PICKUP_PIN_REQUIRED");
  });

  await test("a non-Express ride is not affected by the PIN switch", async () => {
    const rider = await makeUser("rider", "R3"); const drv = await makeDriver();
    const ride = await makeRide(rider, drv, { express: false });
    assert.strictEqual((await call("PATCH", `/api/rides/${ride.id}/status`, drv.token, { status: "in_progress" })).status, 200);
  });

  await test("rider sees the PIN, driver types it, trip starts", async () => {
    const rider = await makeUser("rider", "R4"); const drv = await makeDriver();
    const ride = await makeRide(rider, drv);
    const shown = await call("GET", `/api/safety/rides/${ride.id}/pin`, tokenFor(rider));
    assert.strictEqual(shown.status, 200);
    assert.match(shown.body.pin, /^\d{4}$/);
    assert.strictEqual(shown.body.required, true);
    const ok = await call("POST", `/api/safety/rides/${ride.id}/pin/verify`, drv.token, { pin: shown.body.pin });
    assert.strictEqual(ok.body.verified, true);
    assert.strictEqual((await call("PATCH", `/api/rides/${ride.id}/status`, drv.token, { status: "in_progress" })).status, 200);
    const after = await call("GET", `/api/safety/rides/${ride.id}/pin`, tokenFor(rider));
    assert.strictEqual(after.body.pin, null); // hidden once used
  });

  await test("5 wrong PINs lock the ride; even the right PIN is refused while locked", async () => {
    const rider = await makeUser("rider", "R5"); const drv = await makeDriver();
    const ride = await makeRide(rider, drv);
    const pin = (await call("GET", `/api/safety/rides/${ride.id}/pin`, tokenFor(rider))).body.pin;
    const wrong = pin === "0000" ? "1111" : "0000";
    let last;
    for (let i = 0; i < 5; i++) last = await call("POST", `/api/safety/rides/${ride.id}/pin/verify`, drv.token, { pin: wrong });
    assert.strictEqual(last.status, 429);
    const locked = await call("POST", `/api/safety/rides/${ride.id}/pin/verify`, drv.token, { pin });
    assert.strictEqual(locked.status, 429);
    assert.strictEqual(locked.body.code, "PIN_LOCKED");
    assert.strictEqual((await call("PATCH", `/api/rides/${ride.id}/status`, drv.token, { status: "in_progress" })).status, 403);
    const ev = await pool.query("SELECT 1 FROM safety_events WHERE ride_id = $1 AND kind = 'pin_locked'", [ride.id]);
    assert.ok(ev.rowCount >= 1);
  });

  await test("a different driver and a stranger cannot verify or read the PIN", async () => {
    const rider = await makeUser("rider", "R6"); const drv = await makeDriver(); const other = await makeDriver("Other");
    const ride = await makeRide(rider, drv);
    assert.strictEqual((await call("POST", `/api/safety/rides/${ride.id}/pin/verify`, other.token, { pin: "1234" })).status, 403);
    const stranger = await makeUser("rider", "Stranger");
    assert.strictEqual((await call("GET", `/api/safety/rides/${ride.id}/pin`, tokenFor(stranger))).status, 403);
    assert.strictEqual((await call("GET", `/api/safety/rides/${ride.id}/pin`, null)).status, 401);
  });

  await test("admin override needs a real reason, then lets the trip start", async () => {
    const rider = await makeUser("rider", "R7"); const drv = await makeDriver();
    const ride = await makeRide(rider, drv);
    assert.strictEqual((await call("POST", `/api/admin/safety/rides/${ride.id}/pin-override`, adminToken, { note: "short" })).status, 400);
    assert.strictEqual((await call("POST", `/api/admin/safety/rides/${ride.id}/pin-override`, tokenFor(rider), { note: "a long enough reason here" })).status, 403);
    assert.strictEqual((await call("POST", `/api/admin/safety/rides/${ride.id}/pin-override`, adminToken, { note: "Rider phone died, confirmed by call" })).status, 200);
    assert.strictEqual((await call("PATCH", `/api/rides/${ride.id}/status`, drv.token, { status: "in_progress" })).status, 200);
    const row = (await pool.query("SELECT override_by FROM ride_pickup_pins WHERE ride_id = $1", [ride.id])).rows[0];
    assert.strictEqual(row.override_by, admin.id);
  });
  await sw("safety_pickup_pin_required", false);

  // ───────────── Share links ─────────────
  await test("share link works, shows no driver phone, and dies when revoked", async () => {
    const rider = await makeUser("rider", "S1"); const drv = await makeDriver("Share Driver");
    await pool.query("UPDATE users SET phone = '+2348000000000' WHERE id = $1", [drv.user.id]);
    const ride = await makeRide(rider, drv, { status: "in_progress" });
    const made1 = await call("POST", `/api/safety/rides/${ride.id}/share`, tokenFor(rider));
    assert.strictEqual(made1.status, 201);
    assert.ok(made1.body.expiresAt);
    const token = made1.body.shareUrl.split("share=")[1];
    const stored = await pool.query("SELECT token_hash FROM ride_share_links WHERE ride_id = $1", [ride.id]);
    assert.notStrictEqual(stored.rows[0].token_hash, token); // only the hash is stored
    const view = await call("GET", `/api/safety/track/${token}`);
    assert.strictEqual(view.status, 200);
    assert.strictEqual(view.body.live, true);
    assert.ok(!JSON.stringify(view.body).includes("+2348000000000"));
    const listed = await call("GET", `/api/safety/rides/${ride.id}/share`, tokenFor(rider));
    assert.strictEqual(listed.body.links.length, 1);
    assert.ok(!JSON.stringify(listed.body).includes(token));
    assert.strictEqual((await call("DELETE", `/api/safety/rides/${ride.id}/share`, tokenFor(rider))).body.revoked, 1);
    const dead = await call("GET", `/api/safety/track/${token}`);
    assert.strictEqual(dead.status, 410);
    assert.strictEqual(dead.body.reason, "revoked");
  });

  await test("an expired link answers 410, a made-up one 404", async () => {
    const rider = await makeUser("rider", "S2"); const drv = await makeDriver();
    const ride = await makeRide(rider, drv, { status: "in_progress" });
    const token = (await call("POST", `/api/safety/rides/${ride.id}/share`, tokenFor(rider))).body.shareUrl.split("share=")[1];
    await pool.query("UPDATE ride_share_links SET expires_at = now() - interval '1 minute' WHERE ride_id = $1", [ride.id]);
    const r = await call("GET", `/api/safety/track/${token}`);
    assert.strictEqual(r.status, 410);
    assert.strictEqual(r.body.reason, "expired");
    assert.strictEqual((await call("GET", `/api/safety/track/${"x".repeat(32)}`)).status, 404);
  });

  await test("after the trip ends the link shows status only, then stops after the grace period", async () => {
    const rider = await makeUser("rider", "S3"); const drv = await makeDriver();
    const ride = await makeRide(rider, drv, { status: "in_progress" });
    const token = (await call("POST", `/api/safety/rides/${ride.id}/share`, tokenFor(rider))).body.shareUrl.split("share=")[1];
    await pool.query("UPDATE rides SET ride_status = 'completed', completed_at = now() WHERE id = $1", [ride.id]);
    const justEnded = await call("GET", `/api/safety/track/${token}`);
    assert.strictEqual(justEnded.status, 200);
    assert.strictEqual(justEnded.body.live, false);
    assert.strictEqual(justEnded.body.ride.current_lat, undefined);
    await pool.query("UPDATE rides SET completed_at = now() - interval '30 minutes' WHERE id = $1", [ride.id]);
    const gone = await call("GET", `/api/safety/track/${token}`);
    assert.strictEqual(gone.status, 410);
    assert.strictEqual(gone.body.reason, "ended");
    assert.strictEqual((await call("POST", `/api/safety/rides/${ride.id}/share`, tokenFor(rider))).status, 409);
  });

  await test("at most 5 links stay active; the oldest is retired", async () => {
    const rider = await makeUser("rider", "S4"); const drv = await makeDriver();
    const ride = await makeRide(rider, drv, { status: "accepted" });
    const tokens = [];
    for (let i = 0; i < 6; i++) tokens.push((await call("POST", `/api/safety/rides/${ride.id}/share`, tokenFor(rider))).body.shareUrl.split("share=")[1]);
    assert.strictEqual((await call("GET", `/api/safety/rides/${ride.id}/share`, tokenFor(rider))).body.links.length, 5);
    assert.strictEqual((await call("GET", `/api/safety/track/${tokens[0]}`)).status, 410);
    assert.strictEqual((await call("GET", `/api/safety/track/${tokens[5]}`)).status, 200);
  });

  await test("strangers cannot create, list or revoke links for someone else's ride", async () => {
    const rider = await makeUser("rider", "S5"); const drv = await makeDriver(); const stranger = await makeUser("rider", "S5x");
    const ride = await makeRide(rider, drv, { status: "accepted" });
    for (const [m, p] of [["POST", "share"], ["GET", "share"], ["DELETE", "share"]]) {
      assert.strictEqual((await call(m, `/api/safety/rides/${ride.id}/${p}`, tokenFor(stranger))).status, 403);
    }
  });

  await test("the old /api/rides/:id/share and /track/:token routes use the same rules", async () => {
    const rider = await makeUser("rider", "S6"); const drv = await makeDriver();
    const ride = await makeRide(rider, drv, { status: "accepted" });
    const g = await call("GET", `/api/rides/${ride.id}/share`, tokenFor(rider));
    assert.strictEqual(g.status, 200);
    assert.ok(g.body.shareToken && g.body.shareUrl.includes(g.body.shareToken) && g.body.expiresAt);
    const t = await call("GET", `/api/rides/track/${g.body.shareToken}`);
    assert.strictEqual(t.status, 200);
    assert.ok(t.body.ride);
    // A legacy permanent token still works while the trip is on, and stops after it ends.
    await pool.query("UPDATE rides SET share_token = 'legacytokenlegacytoken1234' WHERE id = $1", [ride.id]);
    assert.strictEqual((await call("GET", "/api/rides/track/legacytokenlegacytoken1234")).status, 200);
    await pool.query("UPDATE rides SET ride_status = 'completed', completed_at = now() - interval '2 hours' WHERE id = $1", [ride.id]);
    assert.strictEqual((await call("GET", "/api/rides/track/legacytokenlegacytoken1234")).status, 410);
  });

  // ───────────── Selfie check ─────────────
  await test("selfie gate is off by default: driver goes online freely", async () => {
    const drv = await makeDriver();
    assert.strictEqual((await call("PATCH", "/api/drivers/status", drv.token, { isOnline: true })).status, 200);
  });

  await sw("safety_selfie_required", true);

  await test("with the gate on: blocked, then allowed once a selfie is submitted", async () => {
    const drv = await makeDriver();
    const blocked = await call("PATCH", "/api/drivers/status", drv.token, { isOnline: true });
    assert.strictEqual(blocked.status, 403);
    assert.strictEqual(blocked.body.code, "SELFIE_REQUIRED");
    const st = await call("GET", "/api/safety/selfie/status", drv.token);
    assert.strictEqual(st.body.allowed, false);
    assert.ok(st.body.challenge);
    const sub = await call("POST", "/api/safety/selfie", drv.token, { imageDataUrl: png, challenge: st.body.challenge });
    assert.strictEqual(sub.status, 201);
    assert.strictEqual((await call("PATCH", "/api/drivers/status", drv.token, { isOnline: true })).status, 200);
    assert.strictEqual((await call("PATCH", "/api/drivers/status", drv.token, { isOnline: false })).status, 200); // going offline never blocked
  });

  await test("a wrong or stale code, a non-image and a rider are all refused", async () => {
    const drv = await makeDriver();
    assert.strictEqual((await call("POST", "/api/safety/selfie", drv.token, { imageDataUrl: png, challenge: "WRONG 00" })).body.code, "CHALLENGE_EXPIRED");
    const ch = (await call("GET", "/api/safety/selfie/status", drv.token)).body.challenge;
    assert.strictEqual((await call("POST", "/api/safety/selfie", drv.token, { imageDataUrl: "data:text/html;base64,AAAA", challenge: ch })).body.code, "IMAGE_INVALID");
    assert.strictEqual((await call("POST", "/api/safety/selfie", drv.token, { challenge: ch })).body.code, "IMAGE_REQUIRED");
    const rider = await makeUser("rider", "NotDriver");
    assert.strictEqual((await call("POST", "/api/safety/selfie", tokenFor(rider), { imageDataUrl: png, challenge: ch })).status, 403);
  });

  await test("admin reject blocks the driver (with a reason); a new selfie unblocks", async () => {
    const drv = await makeDriver();
    const ch = () => call("GET", "/api/safety/selfie/status", drv.token).then((r) => r.body.challenge);
    const sub = await call("POST", "/api/safety/selfie", drv.token, { imageDataUrl: png, challenge: await ch() });
    const pending = await call("GET", "/api/admin/safety/selfies", adminToken);
    assert.ok(pending.body.selfies.some((s) => s.id === sub.body.id));
    assert.strictEqual((await call("POST", `/api/admin/safety/selfies/${sub.body.id}/review`, adminToken, { decision: "rejected" })).status, 400);
    assert.strictEqual((await call("POST", `/api/admin/safety/selfies/${sub.body.id}/review`, adminToken, { decision: "rejected", note: "Face not visible" })).status, 200);
    assert.strictEqual((await call("POST", `/api/admin/safety/selfies/${sub.body.id}/review`, adminToken, { decision: "approved" })).status, 409); // reviewed once
    assert.strictEqual((await call("PATCH", "/api/drivers/status", drv.token, { isOnline: true })).status, 403);
    await call("POST", "/api/safety/selfie", drv.token, { imageDataUrl: png, challenge: await ch() });
    assert.strictEqual((await call("PATCH", "/api/drivers/status", drv.token, { isOnline: true })).status, 200);
  });

  await test("admin can force a re-check, which also takes the driver offline", async () => {
    const drv = await makeDriver();
    const ch = (await call("GET", "/api/safety/selfie/status", drv.token)).body.challenge;
    await call("POST", "/api/safety/selfie", drv.token, { imageDataUrl: png, challenge: ch });
    await call("PATCH", "/api/drivers/status", drv.token, { isOnline: true });
    assert.strictEqual((await call("POST", `/api/admin/safety/drivers/${drv.driver.id}/recheck`, adminToken)).status, 200);
    assert.strictEqual((await pool.query("SELECT is_online FROM drivers WHERE id = $1", [drv.driver.id])).rows[0].is_online, false);
    assert.strictEqual((await call("PATCH", "/api/drivers/status", drv.token, { isOnline: true })).status, 403);
  });
  await sw("safety_selfie_required", false);

  // ───────────── Complaints ─────────────
  const file = (token, body) => call("POST", "/api/safety/complaints", token, body);
  const GOOD = "The driver was speeding and ignored my requests to slow down.";

  await test("a rider files against the driver; the accused is derived from the ride", async () => {
    const rider = await makeUser("rider", "C1"); const drv = await makeDriver();
    const ride = await makeRide(rider, drv, { status: "completed" });
    await pool.query("UPDATE rides SET completed_at = now() WHERE id = $1", [ride.id]);
    const r = await file(tokenFor(rider), { rideId: ride.id, category: "unsafe_driving", description: GOOD, againstUserId: rider.id });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.body.priority, "urgent");
    const row = (await pool.query("SELECT * FROM ride_complaints WHERE id = $1", [r.body.id])).rows[0];
    assert.strictEqual(row.against_user_id, drv.user.id);
    assert.strictEqual(row.filer_role, "rider");
    const gap = new Date(row.respond_by) - new Date(row.created_at);
    assert.ok(Math.abs(gap - 3600000) < 5000);
  });

  await test("a driver files against the rider with driver-only categories", async () => {
    const rider = await makeUser("rider", "C2"); const drv = await makeDriver();
    const ride = await makeRide(rider, drv, { status: "in_progress" });
    const bad = await file(drv.token, { rideId: ride.id, category: "unsafe_driving", description: GOOD });
    assert.strictEqual(bad.body.code, "BAD_CATEGORY");
    const ok = await file(drv.token, { rideId: ride.id, category: "aggressive", description: "The rider shouted and threatened me." });
    assert.strictEqual(ok.status, 201);
    assert.strictEqual((await pool.query("SELECT against_user_id FROM ride_complaints WHERE id = $1", [ok.body.id])).rows[0].against_user_id, rider.id);
  });

  await test("normal complaints get 24 hours; duplicates, short text and strangers are refused", async () => {
    const rider = await makeUser("rider", "C3"); const drv = await makeDriver(); const stranger = await makeUser("rider", "C3x");
    const ride = await makeRide(rider, drv, { status: "accepted" });
    const r = await file(tokenFor(rider), { rideId: ride.id, category: "rude", description: "The driver was quite rude to me." });
    assert.strictEqual(r.body.priority, "normal");
    assert.strictEqual((await file(tokenFor(rider), { rideId: ride.id, category: "rude", description: "The driver was quite rude to me." })).status, 409);
    assert.strictEqual((await file(tokenFor(rider), { rideId: ride.id, category: "other", description: "short" })).body.code, "DESCRIPTION_SHORT");
    assert.strictEqual((await file(tokenFor(rider), { rideId: ride.id, category: "other", description: "x".repeat(1001) })).body.code, "DESCRIPTION_LONG");
    assert.strictEqual((await file(tokenFor(stranger), { rideId: ride.id, category: "other", description: GOOD })).status, 404);
    assert.strictEqual((await file(tokenFor(rider), { rideId: ride.id, category: "other", description: GOOD, photoDataUrl: "data:text/plain;base64,AA" })).body.code, "PHOTO_INVALID");
  });

  await test("closed window and no-driver rides are refused", async () => {
    const rider = await makeUser("rider", "C4"); const drv = await makeDriver();
    const old = await makeRide(rider, drv, { status: "completed" });
    await pool.query("UPDATE rides SET completed_at = now() - interval '4 days' WHERE id = $1", [old.id]);
    assert.strictEqual((await file(tokenFor(rider), { rideId: old.id, category: "rude", description: GOOD })).body.code, "WINDOW_CLOSED");
    const none = await makeRide(rider, null, { status: "requested", express: false });
    assert.strictEqual((await file(tokenFor(rider), { rideId: none.id, category: "rude", description: GOOD })).body.code, "WINDOW_CLOSED");
  });

  await test("the accused can see nothing about reports against them", async () => {
    const rider = await makeUser("rider", "C5"); const drv = await makeDriver();
    const ride = await makeRide(rider, drv, { status: "accepted" });
    await file(tokenFor(rider), { rideId: ride.id, category: "harassment", description: GOOD });
    assert.strictEqual((await call("GET", "/api/safety/complaints/mine", drv.token)).body.complaints.length, 0);
    assert.strictEqual((await call("GET", "/api/safety/complaints/mine", tokenFor(rider))).body.complaints.length, 1);
    assert.strictEqual((await call("GET", "/api/admin/safety/complaints", drv.token)).status, 403);
  });

  await test("2 different riders with urgent reports auto-pause the driver; the same rider twice does not", async () => {
    const drv = await makeDriver();
    await pool.query("UPDATE drivers SET accepts_instant = true WHERE id = $1", [drv.driver.id]);
    const r1 = await makeUser("rider", "P1");
    const ride1 = await makeRide(r1, drv, { status: "completed" });
    await pool.query("UPDATE rides SET completed_at = now() WHERE id = $1", [ride1.id]);
    await file(tokenFor(r1), { rideId: ride1.id, category: "unsafe_driving", description: GOOD });
    await file(tokenFor(r1), { rideId: ride1.id, category: "felt_unsafe", description: GOOD });
    let d = (await pool.query("SELECT accepts_instant, express_paused_at FROM drivers WHERE id = $1", [drv.driver.id])).rows[0];
    assert.strictEqual(d.accepts_instant, true);
    const r2 = await makeUser("rider", "P2");
    const ride2 = await makeRide(r2, drv, { status: "completed" });
    await pool.query("UPDATE rides SET completed_at = now() WHERE id = $1", [ride2.id]);
    await file(tokenFor(r2), { rideId: ride2.id, category: "harassment", description: GOOD });
    d = (await pool.query("SELECT accepts_instant, express_paused_at FROM drivers WHERE id = $1", [drv.driver.id])).rows[0];
    assert.strictEqual(d.accepts_instant, false);
    assert.ok(d.express_paused_at);
  });

  await test("a paused driver cannot re-enable Express through the instant-rides toggle", async () => {
    const drv = await makeDriver();
    await pool.query("UPDATE drivers SET express_paused_at = now() WHERE id = $1", [drv.driver.id]);
    const instant = express();
    instant.use(express.json());
    instant.use("/api/instant-rides", require("./instantRides"));
    const s = http.createServer(instant);
    await new Promise((r) => s.listen(0, r));
    try {
      const res = await fetch(`http://127.0.0.1:${s.address().port}/api/instant-rides/driver/availability`, {
        method: "PATCH", headers: { "Content-Type": "application/json", Authorization: `Bearer ${drv.token}` }, body: JSON.stringify({ acceptsInstant: true }),
      });
      assert.ok([403, 404].includes(res.status), `status ${res.status}`);
      if (res.status === 403) assert.strictEqual((await res.json()).code, "EXPRESS_PAUSED");
    } finally { s.close(); }
  });

  await test("admin resolves: needs a note, applies the action, closes once, logs it", async () => {
    const rider = await makeUser("rider", "A1"); const drv = await makeDriver();
    await pool.query("UPDATE drivers SET accepts_instant = true WHERE id = $1", [drv.driver.id]);
    const ride = await makeRide(rider, drv, { status: "accepted" });
    const c = await file(tokenFor(rider), { rideId: ride.id, category: "vehicle_mismatch", description: "Different car and plate than the app showed." });
    assert.strictEqual((await call("PATCH", `/api/admin/safety/complaints/${c.body.id}`, adminToken, { status: "resolved", action: "pause_driver" })).body.code, "NOTE_REQUIRED");
    assert.strictEqual((await call("PATCH", `/api/admin/safety/complaints/${c.body.id}`, adminToken, { status: "resolved", resolution: "Wrong car", action: "restrict_rider" })).body.code, "ACTION_MISMATCH");
    const ok = await call("PATCH", `/api/admin/safety/complaints/${c.body.id}`, adminToken, { status: "resolved", resolution: "Confirmed wrong vehicle, paused", action: "pause_driver" });
    assert.strictEqual(ok.status, 200);
    const d = (await pool.query("SELECT accepts_instant, express_paused_at FROM drivers WHERE id = $1", [drv.driver.id])).rows[0];
    assert.strictEqual(d.accepts_instant, false);
    assert.ok(d.express_paused_at);
    assert.strictEqual((await call("PATCH", `/api/admin/safety/complaints/${c.body.id}`, adminToken, { status: "dismissed", resolution: "again now" })).status, 409);
    assert.ok((await pool.query("SELECT 1 FROM safety_events WHERE kind = 'complaint_resolved' AND detail->>'complaintId' = $1", [String(c.body.id)])).rowCount === 1);
    const resume = await file(tokenFor(rider), { rideId: ride.id, category: "other", description: "Following up on the earlier report." });
    await call("PATCH", `/api/admin/safety/complaints/${resume.body.id}`, adminToken, { status: "resolved", resolution: "Cleared after review", action: "resume_driver" });
    assert.strictEqual((await pool.query("SELECT express_paused_at FROM drivers WHERE id = $1", [drv.driver.id])).rows[0].express_paused_at, null);
  });

  await test("a driver's report can restrict a rider from booking Express, and be lifted", async () => {
    const rider = await makeUser("rider", "RR"); const drv = await makeDriver();
    const ride = await makeRide(rider, drv, { status: "in_progress" });
    const c = await file(drv.token, { rideId: ride.id, category: "intoxicated", description: "The rider was very drunk and abusive." });
    assert.strictEqual(c.body.priority, "urgent");
    assert.strictEqual((await call("PATCH", `/api/admin/safety/complaints/${c.body.id}`, adminToken, { status: "resolved", resolution: "Confirmed", action: "pause_driver" })).body.code, "ACTION_MISMATCH");
    await call("PATCH", `/api/admin/safety/complaints/${c.body.id}`, adminToken, { status: "resolved", resolution: "Confirmed, restricting", action: "restrict_rider" });
    assert.ok((await pool.query("SELECT express_restricted_at FROM users WHERE id = $1", [rider.id])).rows[0].express_restricted_at);
    const instant = express();
    instant.use(express.json());
    instant.use("/api/instant-rides", require("./instantRides"));
    const s = http.createServer(instant);
    await new Promise((r) => s.listen(0, r));
    try {
      const res = await fetch(`http://127.0.0.1:${s.address().port}/api/instant-rides`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenFor(rider)}` }, body: JSON.stringify({}),
      });
      // 503 when Express is globally off in this environment; otherwise the restriction answers.
      assert.ok([403, 503].includes(res.status), `status ${res.status}`);
      if (res.status === 403) assert.strictEqual((await res.json()).code, "EXPRESS_RESTRICTED");
    } finally { s.close(); }
  });

  await test("the admin overview and queue work, and only admins can use them", async () => {
    const o = await call("GET", "/api/admin/safety/overview", adminToken);
    assert.strictEqual(o.status, 200);
    assert.ok(o.body.switches.every((s) => s.enabled === false));
    const q = await call("GET", "/api/admin/safety/complaints?status=open", adminToken);
    assert.ok(Array.isArray(q.body.complaints));
    for (const role of ["rider", "driver", "support", "operations"]) {
      const u = await makeUser(role, "Nope");
      assert.ok([401, 403].includes((await call("GET", "/api/admin/safety/overview", tokenFor(u))).status));
    }
    assert.strictEqual((await call("PATCH", "/api/admin/safety/switches", adminToken, { key: "bogus", enabled: true })).status, 400);
    assert.strictEqual((await call("PATCH", "/api/admin/safety/switches", adminToken, { key: "safety_selfie_required", enabled: true })).status, 200);
    await sw("safety_selfie_required", false);
  });

  // Clean up, children before parents.
  await pool.query("DELETE FROM ride_complaints WHERE ride_id = ANY($1::int[])", [made.rides]);
  await pool.query("DELETE FROM ride_share_links WHERE ride_id = ANY($1::int[])", [made.rides]);
  await pool.query("DELETE FROM ride_pickup_pins WHERE ride_id = ANY($1::int[])", [made.rides]);
  await pool.query("DELETE FROM safety_events WHERE ride_id = ANY($1::int[]) OR driver_id = ANY($2::int[]) OR user_id = ANY($3::int[])", [made.rides, made.drivers, made.users]);
  await pool.query("DELETE FROM driver_selfie_checks WHERE driver_id = ANY($1::int[])", [made.drivers]);
  await pool.query("DELETE FROM instant_ride_requests WHERE ride_id = ANY($1::int[])", [made.rides]);
  await pool.query("DELETE FROM rides WHERE id = ANY($1::int[])", [made.rides]);
  await pool.query("DELETE FROM drivers WHERE id = ANY($1::int[])", [made.drivers]);
  await pool.query("DELETE FROM vehicles WHERE id = ANY($1::int[])", [made.vehicles]);
  await pool.query("DELETE FROM users WHERE id = ANY($1::int[])", [made.users]);
  await pool.query("DELETE FROM system_config WHERE key IN ('safety_pickup_pin_required','safety_selfie_required')");

  console.log(`\n${passed} passed`);
  server.close();
  await pool.end();
})();
