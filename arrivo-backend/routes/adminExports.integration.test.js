// Operations CSV exports, against a real Postgres and the real router.
//
//   DATABASE_URL=postgres://localhost/... node routes/adminExports.integration.test.js
//   npm run test:integration
//
// What this protects, in the order it matters:
//   1. Who can download. Riders, drivers and strangers get nothing; support and
//      operations get the operational files only; admin gets everything. The
//      Workspace door only opens with the shared secret.
//   2. What is in the files. No password hashes, tokens, passport numbers or ID
//      images, and deleted accounts stay deleted.
//   3. That the file is a faithful record: every row once, in Lagos time, with
//      a header even when empty, and nothing in a name can run as a formula.
//   4. That every download leaves an audit row.

const assert = require("assert");
const http = require("http");
const jwt = require("jsonwebtoken");

process.env.JWT_SECRET = process.env.JWT_SECRET || "integration-test-secret";
// Small, so paging and the size ceiling are exercised with a handful of rows.
process.env.EXPORT_BATCH_SIZE = "2";
process.env.EXPORT_MAX_ROWS = "50";
process.env.EXPORT_RATE_LIMIT = "60";
const PROXY_SECRET = "workspace-proxy-secret-for-tests-0123456789";
process.env.EXPORT_PROXY_SECRET = PROXY_SECRET;

const express = require("express");
require("express-async-errors");
const { pool } = require("../db/db");
const exportsRouter = require("./adminExports");

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
    passed++;
  } catch (e) {
    console.log(`FAIL  ${name}`);
    console.log(`      ${e.message}`);
    process.exitCode = 1;
  }
}

const app = express();
app.use(express.json());
app.use("/api/admin/exports", exportsRouter);
app.use("/api/internal/exports", exportsRouter.workspaceRouter);
app.use((err, req, res, next) => res.status(500).json({ error: "server error", detail: err.message }));
const server = http.createServer(app);

const tag = `exporttest${Date.now()}`;
const ids = {};

function tokenFor(user) {
  return jwt.sign({ id: user.id, email: user.email, role: user.role }, process.env.JWT_SECRET, { expiresIn: "10m" });
}

async function get(path, user) {
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: user ? { Authorization: `Bearer ${tokenFor(user)}` } : {},
  });
  // Read the raw bytes: res.text() quietly drops a leading byte order mark,
  // which is exactly the thing one of the tests needs to see.
  const bytes = Buffer.from(await res.arrayBuffer());
  const text = bytes.toString("utf8");
  return { status: res.status, headers: res.headers, text, bytes };
}

// The Workspace door: no login token, a shared secret and who is asking.
async function viaWorkspace(path, { secret = PROXY_SECRET, email = "someone@ridearrivo.com", role = "operations" } = {}) {
  const { port } = server.address();
  const headers = {};
  if (secret !== null) headers["x-export-proxy-secret"] = secret;
  if (email !== null) headers["x-actor-email"] = email;
  if (role !== null) headers["x-actor-role"] = role;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
  const bytes = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, text: bytes.toString("utf8"), bytes };
}

// A real CSV reader, so the checks read cells and not guesses at substrings.
function parseCsv(text) {
  const body = text.replace(/^﻿/, "");
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quoted) {
      if (c === '"' && body[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\r") { /* swallowed, the \n ends the row */ }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  const [header, ...data] = rows;
  return { header, data, records: data.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]]))) };
}

async function makeUser(label, role, extra = {}) {
  const email = `${tag}-${label}@example.test`;
  const r = await pool.query(
    `INSERT INTO users (name, email, phone, password_hash, role, passport_number, id_document_url, reset_token, wallet_balance_naira, deleted_at)
     VALUES ($1, $2, $3, 'HASH-MUST-NEVER-APPEAR', $4, 'A12345678', 'data:image/png;base64,SECRETIMAGE', 'RESETTOKEN-SECRET', $5, $6)
     RETURNING id, email, role`,
    [extra.name || `${label} user`, email, extra.phone || "+2348011112222", role, extra.balance || 7654321, extra.deletedAt || null]
  );
  return r.rows[0];
}

async function cleanup() {
  await pool.query("DELETE FROM export_audit_log WHERE user_email LIKE $1", [`${tag}%`]);
  await pool.query("DELETE FROM export_audit_log WHERE user_email LIKE 'ws.%@ridearrivo.com' OR user_email = 'someone@ridearrivo.com'");
  await pool.query("DELETE FROM wallet_transactions WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)", [`${tag}%`]);
  await pool.query("DELETE FROM instant_ride_offers WHERE request_id IN (SELECT id FROM instant_ride_requests WHERE rider_id IN (SELECT id FROM users WHERE email LIKE $1))", [`${tag}%`]);
  await pool.query("DELETE FROM instant_ride_requests WHERE rider_id IN (SELECT id FROM users WHERE email LIKE $1)", [`${tag}%`]);
  await pool.query("DELETE FROM ride_cancellations WHERE ride_id IN (SELECT id FROM rides WHERE rider_id IN (SELECT id FROM users WHERE email LIKE $1))", [`${tag}%`]);
  await pool.query("DELETE FROM rides WHERE rider_id IN (SELECT id FROM users WHERE email LIKE $1)", [`${tag}%`]);
  await pool.query("DELETE FROM drivers WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)", [`${tag}%`]);
  await pool.query("DELETE FROM vehicles WHERE owner_user_id IN (SELECT id FROM users WHERE email LIKE $1)", [`${tag}%`]);
  await pool.query("DELETE FROM users WHERE email LIKE $1", [`${tag}%`]);
}

(async () => {
  await require("../db/db").ready;
  await new Promise((resolve) => server.listen(0, resolve));
  await cleanup();

  try {
    ids.admin = await makeUser("admin", "admin");
    ids.ops = await makeUser("ops", "operations");
    ids.ops2 = await makeUser("ops2", "operations");
    ids.ops3 = await makeUser("ops3", "operations");
    ids.support = await makeUser("support", "support");
    ids.rider = await makeUser("rider", "rider", { name: "Ada Okafor", phone: "+2348033334444" });
    ids.evil = await makeUser("evil", "rider", { name: '=HYPERLINK("http://evil.test","click")', phone: "+2348055556666" });
    ids.gone = await makeUser("gone", "rider", { name: "Removed Person", phone: "+2348077778888", deletedAt: new Date() });
    ids.driverUser = await makeUser("driver", "driver", { name: "Chidi Driver", phone: "+2348099990000" });

    const vehicle = (await pool.query(
      "INSERT INTO vehicles (owner_user_id, make_model, plate_number, vehicle_type, seats) VALUES ($1, 'Toyota Sienna', 'EXP-123AB', 'suv', 6) RETURNING id",
      [ids.ops.id]
    )).rows[0];
    const driver = (await pool.query(
      `INSERT INTO drivers (user_id, vehicle_id, license_number, lasdri_number, is_verified, is_online, accepts_instant, scan_token, license_photo_url, emergency_contact_phone)
       VALUES ($1, $2, 'LICENSE-SECRET-777', 'LASDRI-555', true, true, true, 'SCANTOKEN-SECRET', 'data:image/jpeg;base64,LICENSEPHOTO', '+2348000000001') RETURNING id`,
      [ids.driverUser.id, vehicle.id]
    )).rows[0];
    ids.driverRow = driver.id;

    // 23:30 UTC on 6 Oct is 00:30 on 7 Oct in Lagos. This ride is the one that
    // proves dates are read as Lagos days, not UTC days.
    const boundary = (await pool.query(
      `INSERT INTO rides (rider_id, driver_id, pickup_address, fare_naira, ride_status, payment_status, created_at, emergency_contact_name, emergency_contact_phone, admin_notes)
       VALUES ($1, $2, 'Murtala Muhammed Airport', 25000, 'completed', 'paid', '2026-10-06T23:30:00Z', 'EMERGENCY-NAME', '+2348111111111', 'ADMIN-NOTE-SECRET') RETURNING id`,
      [ids.rider.id, driver.id]
    )).rows[0];
    ids.boundaryRide = boundary.id;
    const goneRide = (await pool.query(
      `INSERT INTO rides (rider_id, driver_id, pickup_address, fare_naira, ride_status, payment_status, created_at, panic_triggered_at, panic_resolved_at, panic_notes)
       VALUES ($1, $2, 'Lekki Phase 1', 18000, 'completed', 'paid', '2026-10-05T10:00:00Z', '2026-10-05T10:20:00Z', '2026-10-05T10:40:00Z', 'Rider felt unsafe, resolved by phone') RETURNING id`,
      [ids.gone.id, driver.id]
    )).rows[0];
    ids.goneRide = goneRide.id;

    await pool.query("INSERT INTO ride_cancellations (ride_id, driver_id, reason, reassigned) VALUES ($1, $2, 'vehicle_breakdown', true)", [boundary.id, driver.id]);

    const request = (await pool.query(
      `INSERT INTO instant_ride_requests (rider_id, pickup_address, pickup_lat, pickup_lng, destination_address, destination_lat, destination_lng, estimated_fare_naira, status, matched_driver_id)
       VALUES ($1, 'Ikeja City Mall', 6.6, 3.35, 'Victoria Island', 6.43, 3.42, 12000, 'matched', $2) RETURNING id`,
      [ids.rider.id, driver.id]
    )).rows[0];
    await pool.query(
      "INSERT INTO instant_ride_offers (request_id, driver_id, status, distance_to_pickup_km, eta_to_pickup_min, expires_at) VALUES ($1, $2, 'accepted', 1.5, 4, now())",
      [request.id, driver.id]
    );
    await pool.query("INSERT INTO wallet_transactions (user_id, type, amount_naira, balance_after_naira, description) VALUES ($1, 'topup', 50000, 50000, 'Top up')", [ids.rider.id]);

    // ── Who can download ──────────────────────────────────────────

    await test("no token is refused", async () => {
      assert.equal((await get("/api/admin/exports/riders")).status, 401);
      assert.equal((await get("/api/admin/exports")).status, 401);
    });

    await test("riders and drivers are refused everywhere, including the list", async () => {
      for (const user of [ids.rider, ids.driverUser]) {
        for (const path of ["/api/admin/exports", "/api/admin/exports/riders", "/api/admin/exports/drivers", "/api/admin/exports/history"]) {
          const r = await get(path, user);
          assert.equal(r.status, 403, `${user.role} should be refused ${path}`);
        }
      }
    });

    await test("support gets the operational exports but not the money ones or the history", async () => {
      const list = JSON.parse((await get("/api/admin/exports", ids.support)).text);
      const keys = list.datasets.map((d) => d.key);
      assert.ok(keys.includes("riders") && keys.includes("rides"));
      assert.ok(!keys.includes("wallet-transactions") && !keys.includes("memberships"));
      assert.equal((await get("/api/admin/exports/riders", ids.support)).status, 200);
      assert.equal((await get("/api/admin/exports/wallet-transactions", ids.support)).status, 403);
      assert.equal((await get("/api/admin/exports/history", ids.support)).status, 403);
    });

    await test("operations sees the operational exports and not the money ones", async () => {
      const list = JSON.parse((await get("/api/admin/exports", ids.ops)).text);
      const keys = list.datasets.map((d) => d.key);
      for (const k of ["riders", "drivers", "vehicles", "rides", "arrivoexpress-requests", "arrivoexpress-offers", "cancellations", "safety-incidents", "flight-issues"]) {
        assert.ok(keys.includes(k), `operations should be offered ${k}`);
      }
      assert.ok(!keys.includes("wallet-transactions"));
      assert.ok(!keys.includes("memberships"));
    });

    await test("admin sees everything, including the money exports", async () => {
      const list = JSON.parse((await get("/api/admin/exports", ids.admin)).text);
      const keys = list.datasets.map((d) => d.key);
      assert.ok(keys.includes("wallet-transactions"));
      assert.ok(keys.includes("memberships"));
    });

    await test("operations cannot download admin-only exports or read the history", async () => {
      assert.equal((await get("/api/admin/exports/wallet-transactions", ids.ops)).status, 403);
      assert.equal((await get("/api/admin/exports/memberships", ids.ops)).status, 403);
      assert.equal((await get("/api/admin/exports/history", ids.ops)).status, 403);
    });

    await test("admin can download the wallet ledger", async () => {
      const r = await get("/api/admin/exports/wallet-transactions", ids.admin);
      assert.equal(r.status, 200);
      assert.match(r.text, /Top up/);
    });

    await test("an unknown export is a 404, not an error", async () => {
      assert.equal((await get("/api/admin/exports/users", ids.admin)).status, 404);
      assert.equal((await get("/api/admin/exports/__proto__", ids.admin)).status, 404);
      assert.equal((await get("/api/admin/exports/constructor", ids.admin)).status, 404);
    });

    // ── What is in the file ───────────────────────────────────────

    const FORBIDDEN = [
      "HASH-MUST-NEVER-APPEAR", "RESETTOKEN-SECRET", "A12345678", "SECRETIMAGE",
      "SCANTOKEN-SECRET", "LICENSE-SECRET-777", "LICENSEPHOTO", "EMERGENCY-NAME",
      "+2348111111111", "ADMIN-NOTE-SECRET", "+2348000000001", "7654321",
    ];

    await test("every operational export is free of secrets and sensitive fields", async () => {
      for (const key of ["riders", "drivers", "vehicles", "rides", "arrivoexpress-requests", "arrivoexpress-offers", "cancellations", "safety-incidents", "flight-issues"]) {
        const r = await get(`/api/admin/exports/${key}`, ids.ops);
        assert.equal(r.status, 200, key);
        for (const secret of FORBIDDEN) {
          assert.ok(!r.text.includes(secret), `${key} must not contain ${secret}`);
        }
        const header = parseCsv(r.text).header.join(",");
        assert.ok(!/password|token|passport|id_document|wallet_balance|license_number|emergency|admin_notes|(^|[,_])(lat|lng)([,_]|$)/.test(header), `${key} header has a sensitive column: ${header}`);
      }
    });

    await test("download headers: csv, attachment, UTF-8 BOM, no caching, row count", async () => {
      const r = await get("/api/admin/exports/riders", ids.ops);
      assert.match(r.headers.get("content-type"), /text\/csv; charset=utf-8/);
      assert.match(r.headers.get("content-disposition"), /^attachment; filename="arrivo-riders-exported-\d{4}-\d{2}-\d{2}\.csv"$/);
      assert.equal(r.headers.get("cache-control"), "no-store");
      assert.ok(r.text.startsWith("﻿"));
      assert.equal(Number(r.headers.get("x-row-count")), parseCsv(r.text).data.length);
    });

    await test("riders: real rider present, deleted account absent, formula neutralised", async () => {
      const csv = parseCsv((await get("/api/admin/exports/riders", ids.ops)).text);
      const names = csv.records.map((r) => r.name);
      assert.ok(names.includes("Ada Okafor"));
      assert.ok(!names.includes("Removed Person"), "deleted account must not be exported");
      const evil = csv.records.find((r) => r.email === ids.evil.email);
      assert.ok(evil, "evil rider row present");
      assert.ok(evil.name.startsWith("'="), `name must be defused, got ${evil.name}`);
      const ada = csv.records.find((r) => r.email === ids.rider.email);
      assert.equal(ada.phone, "+2348033334444", "phone numbers are left alone");
      assert.equal(ada.trips_booked, "1");
      assert.equal(ada.trips_completed, "1");
    });

    await test("drivers: verification and vehicle shown, licence number withheld", async () => {
      const csv = parseCsv((await get("/api/admin/exports/drivers", ids.ops)).text);
      const row = csv.records.find((r) => r.name === "Chidi Driver");
      assert.ok(row);
      assert.equal(row.plate_number, "EXP-123AB");
      assert.equal(row.verified, "yes");
      assert.equal(row.arrivoexpress_opt_in, "yes");
      assert.equal(row.lasdri_number, "LASDRI-555");
      assert.equal(row.trips_completed, "2");
    });

    await test("trips: deleted rider is anonymised, Lagos time and driver details are right", async () => {
      const csv = parseCsv((await get("/api/admin/exports/rides", ids.ops)).text);
      const gone = csv.records.find((r) => r.trip_id === String(ids.goneRide));
      assert.equal(gone.rider_name, "Deleted account");
      assert.equal(gone.rider_phone, "");
      assert.equal(gone.driver_name, "Chidi Driver");
      assert.equal(gone.plate_number, "EXP-123AB");
      assert.equal(gone.booked_wat, "2026-10-05 11:00:00", "10:00 UTC is 11:00 in Lagos");
      const boundary = csv.records.find((r) => r.trip_id === String(ids.boundaryRide));
      assert.equal(boundary.booked_wat, "2026-10-07 00:30:00");
      assert.equal(boundary.fare_naira, "25000");
    });

    await test("safety incidents, cancellations and ArrivoExpress exports carry their records", async () => {
      const safety = parseCsv((await get("/api/admin/exports/safety-incidents", ids.ops)).text);
      const incident = safety.records.find((r) => r.trip_id === String(ids.goneRide));
      assert.ok(incident);
      assert.equal(incident.raised_wat, "2026-10-05 11:20:00");
      assert.equal(incident.resolved_wat, "2026-10-05 11:40:00");
      assert.match(incident.notes, /unsafe/);

      const cancellations = parseCsv((await get("/api/admin/exports/cancellations", ids.ops)).text);
      assert.ok(cancellations.records.some((r) => r.trip_id === String(ids.boundaryRide) && r.reason === "vehicle_breakdown" && r.reassigned === "yes"));

      const requests = parseCsv((await get("/api/admin/exports/arrivoexpress-requests", ids.ops)).text);
      const req = requests.records.find((r) => r.pickup === "Ikeja City Mall");
      assert.equal(req.outcome, "matched");
      assert.equal(req.drivers_offered, "1");
      assert.equal(req.matched_driver, "Chidi Driver");

      const offers = parseCsv((await get("/api/admin/exports/arrivoexpress-offers", ids.ops)).text);
      assert.ok(offers.records.some((r) => r.driver_name === "Chidi Driver" && r.answer === "accepted"));
    });

    // ── Dates ─────────────────────────────────────────────────────

    await test("dates are Lagos days: 23:30 UTC on the 6th belongs to the 7th", async () => {
      const on7th = parseCsv((await get("/api/admin/exports/rides?from=2026-10-07&to=2026-10-07", ids.ops)).text);
      assert.ok(on7th.records.some((r) => r.trip_id === String(ids.boundaryRide)));
      const on6th = parseCsv((await get("/api/admin/exports/rides?from=2026-10-06&to=2026-10-06", ids.ops)).text);
      assert.ok(!on6th.records.some((r) => r.trip_id === String(ids.boundaryRide)));
    });

    await test("the To date includes the whole of that day", async () => {
      const csv = parseCsv((await get("/api/admin/exports/rides?from=2026-10-05&to=2026-10-05", ids.ops)).text);
      assert.ok(csv.records.some((r) => r.trip_id === String(ids.goneRide)));
    });

    await test("an empty range still returns a header row", async () => {
      const r = await get("/api/admin/exports/rides?from=2031-01-01&to=2031-01-02", ids.ops);
      assert.equal(r.status, 200);
      const csv = parseCsv(r.text);
      assert.equal(csv.data.length, 0);
      assert.ok(csv.header.includes("trip_id") && csv.header.includes("booked_wat"));
      assert.equal(r.headers.get("x-row-count"), "0");
    });

    await test("bad dates are rejected with a clear message", async () => {
      for (const q of ["from=yesterday", "from=2026-13-40", "to=2026-02-30", "from=2026-10-08&to=2026-10-01", "from=2026-1-1"]) {
        const r = await get(`/api/admin/exports/rides?${q}`, ids.ops);
        assert.equal(r.status, 400, q);
        assert.ok(JSON.parse(r.text).error);
      }
    });

    await test("injection through the date filter does nothing", async () => {
      const r = await get(`/api/admin/exports/rides?from=${encodeURIComponent("2026-10-01'; DROP TABLE rides;--")}`, ids.ops);
      assert.equal(r.status, 400);
      assert.equal((await pool.query("SELECT to_regclass('public.rides') AS t")).rows[0].t, "rides");
    });

    // ── Paging and size ───────────────────────────────────────────

    await test("paging returns every row once with a batch size of 2", async () => {
      const csv = parseCsv((await get("/api/admin/exports/riders", ids.ops)).text);
      const mine = csv.records.filter((r) => r.email.startsWith(tag));
      const unique = new Set(mine.map((r) => r.rider_id));
      assert.equal(mine.length, unique.size, "no rider twice");
      assert.equal(mine.length, 2, "ada and the formula rider, not the deleted one");
      const idsInOrder = csv.records.map((r) => Number(r.rider_id));
      assert.deepEqual(idsInOrder, [...idsInOrder].sort((a, b) => a - b), "ordered by id");
    });

    await test("a file bigger than the ceiling is refused with advice", async () => {
      await pool.query(
        `INSERT INTO users (name, email, password_hash, role)
         SELECT 'Bulk ' || g, $1 || '-bulk' || g || '@example.test', 'x', 'rider' FROM generate_series(1, 60) g`,
        [tag]
      );
      const r = await get("/api/admin/exports/riders", ids.ops);
      assert.equal(r.status, 413);
      assert.match(JSON.parse(r.text).error, /shorter date range/);
      await pool.query("DELETE FROM users WHERE email LIKE $1", [`${tag}-bulk%`]);
    });

    // ── Audit trail ───────────────────────────────────────────────

    await test("every download is on the audit log with who, what, range and rows", async () => {
      await get("/api/admin/exports/vehicles?from=2026-01-01&to=2026-12-31", ids.ops2);
      const row = (await pool.query(
        "SELECT *, to_char(date_from, 'YYYY-MM-DD') AS from_text FROM export_audit_log WHERE user_email = $1 AND dataset = 'vehicles' ORDER BY id DESC LIMIT 1",
        [ids.ops2.email]
      )).rows[0];
      assert.ok(row, "audit row exists");
      assert.equal(row.user_role, "operations");
      assert.equal(row.status, "completed");
      assert.equal(row.from_text, "2026-01-01");
      assert.ok(row.row_count >= 1);
      assert.ok(row.completed_at);
    });

    await test("refused requests are not logged as downloads", async () => {
      const before = (await pool.query("SELECT COUNT(*)::int n FROM export_audit_log WHERE user_email = $1", [ids.support.email])).rows[0].n;
      await get("/api/admin/exports/wallet-transactions", ids.support);
      const after = (await pool.query("SELECT COUNT(*)::int n FROM export_audit_log WHERE user_email = $1", [ids.support.email])).rows[0].n;
      assert.equal(before, after);
    });

    // ── The Workspace door ────────────────────────────────────────

    await test("workspace door is shut without the secret, with a wrong one, or without an identity", async () => {
      assert.equal((await viaWorkspace("/api/internal/exports/riders", { secret: null })).status, 401);
      assert.equal((await viaWorkspace("/api/internal/exports/riders", { secret: "wrong" + PROXY_SECRET })).status, 401);
      assert.equal((await viaWorkspace("/api/internal/exports/riders", { email: null })).status, 403);
      assert.equal((await viaWorkspace("/api/internal/exports/riders", { email: "not-an-email" })).status, 403);
    });

    await test("workspace door refuses roles that may not export", async () => {
      for (const role of ["finance", "rider", "manager", "", null]) {
        assert.equal((await viaWorkspace("/api/internal/exports", { role })).status, 403, `role ${role}`);
      }
    });

    await test("workspace door is disabled when no secret is configured", async () => {
      const keep = process.env.EXPORT_PROXY_SECRET;
      process.env.EXPORT_PROXY_SECRET = "short";
      try {
        assert.equal((await viaWorkspace("/api/internal/exports", { secret: "short" })).status, 503);
      } finally {
        process.env.EXPORT_PROXY_SECRET = keep;
      }
    });

    await test("workspace operations and support get a real file; money files stay admin only", async () => {
      for (const role of ["operations", "support"]) {
        const r = await viaWorkspace("/api/internal/exports/riders", { role, email: `ws.${role}@ridearrivo.com` });
        assert.equal(r.status, 200);
        assert.deepEqual([...r.bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
        assert.ok(/attachment; filename="arrivo-riders-/.test(r.headers.get("content-disposition")));
        assert.equal((await viaWorkspace("/api/internal/exports/wallet-transactions", { role })).status, 403);
        assert.equal((await viaWorkspace("/api/internal/exports/history", { role })).status, 403);
      }
      const admin = await viaWorkspace("/api/internal/exports/wallet-transactions", { role: "admin", email: "ws.admin@ridearrivo.com" });
      assert.equal(admin.status, 200);
    });

    await test("a workspace download is audited under the real person and marked as workspace", async () => {
      const row = (await pool.query(
        "SELECT user_id, user_role, source, status, ip FROM export_audit_log WHERE user_email = 'ws.support@ridearrivo.com' AND dataset = 'riders' ORDER BY id DESC LIMIT 1"
      )).rows[0];
      assert.ok(row, "audit row exists");
      assert.equal(row.user_id, null);
      assert.equal(row.user_role, "support");
      assert.equal(row.source, "workspace");
      assert.equal(row.status, "completed");
      assert.equal(row.ip, null);
      const consoleRow = (await pool.query("SELECT source FROM export_audit_log WHERE user_email = $1 ORDER BY id DESC LIMIT 1", [ids.support.email])).rows[0];
      assert.equal(consoleRow.source, "console");
    });

    await test("admin can read the history and it names who downloaded", async () => {
      const r = await get("/api/admin/exports/history", ids.admin);
      assert.equal(r.status, 200);
      const history = JSON.parse(r.text).history;
      assert.ok(history.some((h) => h.user_email === ids.ops2.email && h.dataset === "vehicles"));
      assert.ok(history.every((h) => !("user_agent" in h)));
    });

    // ── Rate limit ────────────────────────────────────────────────

    await test("a runaway downloader is slowed down", async () => {
      let limited = 0;
      for (let i = 0; i < 63; i++) {
        const r = await get("/api/admin/exports/vehicles", ids.ops3);
        if (r.status === 429) limited++;
      }
      assert.equal(limited, 3, "60 downloads an hour are allowed, the rest are refused");
      // Another person is not affected by it.
      assert.equal((await get("/api/admin/exports/vehicles", ids.admin)).status, 200);
    });
  } finally {
    await cleanup();
    server.close();
    await pool.end();
  }
  console.log(`\n${passed} passed`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
