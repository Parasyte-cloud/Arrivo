// Run: DATABASE_URL=... node routes/tripTracker.integration.test.js
// The Trip Tracker keeps full numbers out of the list and the trip panel, and
// logs every look at them and every call from a staff member's own phone.
const assert = require("assert");
const http = require("http");
const jwt = require("jsonwebtoken");

process.env.JWT_SECRET = process.env.JWT_SECRET || "integration-test-secret";

const express = require("express");
require("express-async-errors");
const { pool, ready } = require("../db/db");

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
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const stamp = Date.now();
const made = [];
async function makeUser(tag, role, phone) {
  const email = `tt-${tag}-${stamp}@example.com`;
  const row = (await pool.query(
    `INSERT INTO users (name, email, password_hash, role, agreed_to_terms, email_verified, phone)
     VALUES ($1, $2, 'x', $3, true, true, $4) RETURNING id, token_version`, [`TT ${tag}`, email, role, phone])).rows[0];
  made.push(row.id);
  return { id: row.id, token: jwt.sign({ id: row.id, email, role, tv: row.token_version }, process.env.JWT_SECRET, { expiresIn: "1h" }) };
}
const accessRows = async (staffId) => (await pool.query(
  "SELECT subject_role, action FROM staff_contact_access WHERE staff_user_id = $1 ORDER BY id", [staffId])).rows;

(async () => {
  await ready;
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  let rideId = null;
  try {
    const rider = await makeUser("rider", "rider", "+2348012345678");
    const ops = await makeUser("ops", "operations", null);
    const admin = await makeUser("admin", "admin", null);
    rideId = (await pool.query(
      `INSERT INTO rides (rider_id, pickup_address, vehicle_type, fare_naira, booking_type, ride_status, emergency_contact_name, emergency_contact_phone)
       VALUES ($1, 'Murtala Muhammed Airport, Lagos', 'sedan', 30000, 'one_way', 'requested', 'Mum', '+2348099990000') RETURNING id`,
      [rider.id])).rows[0].id;

    await test("the list carries hints, never the full numbers or email", async () => {
      const r = await call("/api/admin/trips/active", ops.token);
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      const t = r.body.trips.find((x) => x.id === rideId);
      assert.ok(t, "ride listed");
      const text = JSON.stringify(t);
      assert.ok(!text.includes("2348012345678") && !text.includes("2348099990000"), "no full number anywhere");
      assert.ok(!("rider_email" in t) && !("rider_phone" in t) && !("emergency_contact_phone" in t));
      assert.strictEqual(t.rider_phone_hint, "••• 678");
      assert.strictEqual(t.has_emergency_contact, true);
    });

    await test("the trip panel carries hints too", async () => {
      const r = await call(`/api/admin/trips/${rideId}`, ops.token);
      assert.strictEqual(r.status, 200);
      assert.ok(!JSON.stringify(r.body.trip).includes("2348012345678"));
    });

    await test("looking at the list logs nothing", async () => {
      assert.deepStrictEqual(await accessRows(ops.id), []);
    });

    await test("Show numbers returns them and logs the look", async () => {
      const r = await call(`/api/admin/trips/${rideId}/contacts`, ops.token);
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.rider.phone, "+2348012345678");
      assert.ok(!("email" in r.body.rider), "contacts endpoint must not disclose rider email");
      assert.strictEqual(r.body.emergencyContact.phone, "+2348099990000");
      assert.deepStrictEqual(await accessRows(ops.id), [
        { subject_role: "rider", action: "view_number" },
        { subject_role: "emergency_contact", action: "view_number" },
      ]);
    });

    await test("every repeated reveal is independently audited", async () => {
      await call(`/api/admin/trips/${rideId}/contacts`, ops.token);
      assert.deepStrictEqual(await accessRows(ops.id), [
        { subject_role: "rider", action: "view_number" },
        { subject_role: "emergency_contact", action: "view_number" },
        { subject_role: "rider", action: "view_number" },
        { subject_role: "emergency_contact", action: "view_number" },
      ]);
    });

    await test("dialling from your own phone is logged, emergency contact against the rider", async () => {
      assert.strictEqual((await call(`/api/admin/trips/${rideId}/contact-log`, ops.token, { method: "POST", body: { subject: "rider" } })).status, 201);
      assert.strictEqual((await call(`/api/admin/trips/${rideId}/contact-log`, ops.token, { method: "POST", body: { subject: "emergency" } })).status, 201);
      const rows = await accessRows(ops.id);
      assert.deepStrictEqual(rows.slice(4), [
        { subject_role: "rider", action: "call_from_phone" },
        { subject_role: "emergency_contact", action: "call_from_phone" },
      ]);
    });

    await test("a driver call on a ride with no driver says so", async () => {
      const r = await call(`/api/admin/trips/${rideId}/contact-log`, admin.token, { method: "POST", body: { subject: "driver" } });
      assert.strictEqual(r.status, 409);
    });

    await test("junk is refused", async () => {
      assert.strictEqual((await call(`/api/admin/trips/${rideId}/contact-log`, admin.token, { method: "POST", body: { subject: "boss" } })).status, 400);
      assert.strictEqual((await call("/api/admin/trips/abc/contacts", admin.token)).status, 400);
    });

    await test("a rider can't reach any of it", async () => {
      assert.strictEqual((await call(`/api/admin/trips/${rideId}/contacts`, rider.token)).status, 403);
    });
  } finally {
    if (rideId) {
      await pool.query("DELETE FROM staff_contact_access WHERE ride_id = $1", [rideId]).catch(() => {});
      await pool.query("DELETE FROM ride_team_events WHERE ride_id = $1", [rideId]).catch(() => {});
      await pool.query("DELETE FROM ride_team WHERE ride_id = $1", [rideId]).catch(() => {});
      await pool.query("DELETE FROM rides WHERE id = $1", [rideId]).catch(() => {});
    }
    if (made.length) await pool.query("DELETE FROM users WHERE id = ANY($1)", [made]).catch(() => {});
    server.close();
    await pool.end();
    console.log(`\ntripTracker integration: ${passed} passed`);
  }
})();
