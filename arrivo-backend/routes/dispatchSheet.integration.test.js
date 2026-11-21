// The offline dispatch sheet (GET /api/admin/trips/dispatch-sheet), against a REAL Postgres.
//   DATABASE_URL=postgres://... node routes/dispatchSheet.integration.test.js
const assert = require("assert");
const http = require("http");
const jwt = require("jsonwebtoken");
process.env.JWT_SECRET = process.env.JWT_SECRET || "integration-test-secret";
const express = require("express");
require("express-async-errors");
const { pool, ready } = require("../db/db");
const adminRouter = require("./admin");

const app = express();
app.use(express.json());
app.use("/api/admin", adminRouter);
app.use((err, req, res, next) => res.status(500).json({ error: "server error", detail: err.message }));
const server = http.createServer(app);

let seq = 0;
const stamp = Date.now();
const made = [];
async function mkUser(role) {
  seq++;
  const r = await pool.query(
    "INSERT INTO users (name, email, phone, password_hash, role) VALUES ($1,$2,$3,'x',$4) RETURNING id",
    [`Sheet ${role} ${seq}`, `sheet-${role}-${seq}-${stamp}@example.com`, `+2348022${String(100000 + seq)}`, role]
  );
  const id = r.rows[0].id; made.push(id);
  return { id, token: jwt.sign({ id, email: `u${id}@example.com`, role, tv: 0 }, process.env.JWT_SECRET, { algorithm: "HS256" }) };
}
async function get(path, as) {
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers: as ? { Authorization: `Bearer ${as.token}` } : {} });
  let body = {}; try { body = await res.json(); } catch (_) {}
  return { status: res.status, body };
}

(async () => {
  await ready;
  await new Promise((r) => server.listen(0, r));
  const adm = await mkUser("admin");
  const ops = await mkUser("operations");
  const rider = await mkUser("rider");
  const live = (await pool.query("INSERT INTO rides (rider_id, pickup_address, fare_naira, ride_status) VALUES ($1,'Lekki Phase 1',9000,'requested') RETURNING id", [rider.id])).rows[0].id;
  const done = (await pool.query("INSERT INTO rides (rider_id, pickup_address, fare_naira, ride_status) VALUES ($1,'Ikeja',9000,'completed') RETURNING id", [rider.id])).rows[0].id;

  const r = await get("/api/admin/trips/dispatch-sheet", adm);
  assert.strictEqual(r.status, 200, "not read as a ride id");
  const mine = r.body.trips.find((t) => t.id === live);
  assert.ok(mine, "live ride is on the sheet");
  assert.ok(/^\+2348022/.test(mine.riderPhone), "full phone number is on the sheet");
  assert.ok(!r.body.trips.some((t) => t.id === done), "finished rides are not on the sheet");
  console.log("  ok  sheet lists live rides with full numbers");

  const logged = await pool.query("SELECT 1 FROM staff_contact_access WHERE staff_user_id=$1 AND ride_id=$2 AND action='view_number'", [adm.id, live]);
  assert.strictEqual(logged.rowCount, 1);
  console.log("  ok  taking the sheet is logged as a number view");

  await get("/api/admin/trips/dispatch-sheet", adm);
  const again = await pool.query("SELECT 1 FROM staff_contact_access WHERE staff_user_id=$1 AND ride_id=$2 AND action='view_number'", [adm.id, live]);
  assert.strictEqual(again.rowCount, 1, "a refresh within 10 minutes does not bury the log");
  console.log("  ok  the 10 minute dedupe still holds with the one-statement write");

  assert.strictEqual((await get("/api/admin/trips/dispatch-sheet", ops)).status, 200);
  console.log("  ok  operations can take it too (trip tracker access)");

  assert.strictEqual((await get("/api/admin/trips/dispatch-sheet")).status, 401);
  console.log("  ok  no token, no sheet");

  await pool.query("DELETE FROM staff_contact_access WHERE staff_user_id = ANY($1)", [made]);
  await pool.query("DELETE FROM rides WHERE rider_id = ANY($1)", [made]);
  await pool.query("DELETE FROM users WHERE id = ANY($1)", [made]);
  server.close();
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
