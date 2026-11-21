// Ops Drivers list (GET /api/admin/drivers), against a REAL Postgres.
//   DATABASE_URL=postgres://... node routes/adminDrivers.integration.test.js
// Signup is two steps (account, then driver profile). Ops must see people who stopped after step 1.
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
async function mkUser(role, name) {
  seq++;
  const r = await pool.query(
    "INSERT INTO users (name, email, phone, password_hash, role) VALUES ($1,$2,$3,'x',$4) RETURNING id",
    [name || `Drv ${role} ${seq}`, `drvlist-${role}-${seq}-${stamp}@example.com`, `+2348033${String(200000 + seq)}`, role]
  );
  const id = r.rows[0].id; made.push(id);
  return { id, token: jwt.sign({ id, email: `u${id}@example.com`, role, tv: 0 }, process.env.JWT_SECRET, { algorithm: "HS256" }) };
}
async function call(path, as, method = "GET") {
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { Authorization: `Bearer ${as.token}`, "content-type": "application/json" }, body: method === "GET" ? undefined : "{}" });
  let body = {}; try { body = await res.json(); } catch (_) {}
  return { status: res.status, body };
}

(async () => {
  await ready;
  await new Promise((r) => server.listen(0, r));
  const adm = await mkUser("admin");
  const ops = await mkUser("operations");
  const complete = await mkUser("driver", `Complete ${stamp}`);
  const incomplete = await mkUser("driver", `Incomplete ${stamp}`);
  const archived = await mkUser("driver", `Archived ${stamp}`);
  await pool.query("INSERT INTO drivers (user_id, scan_token) VALUES ($1, $2)", [complete.id, `t1-${stamp}`]);
  await pool.query("INSERT INTO drivers (user_id, scan_token, archived_at) VALUES ($1, $2, now())", [archived.id, `t2-${stamp}`]);

  const list = await call("/api/admin/drivers", ops);
  assert.strictEqual(list.status, 200);
  const byUser = (id) => list.body.drivers.find((d) => d.user_id === id);
  assert.ok(byUser(complete.id), "a driver with a profile is listed");
  assert.strictEqual(byUser(complete.id).profile_incomplete, false);
  const inc = byUser(incomplete.id);
  assert.ok(inc, "a driver who stopped after step 1 is listed, with their name");
  assert.strictEqual(inc.name, `Incomplete ${stamp}`);
  assert.strictEqual(inc.profile_incomplete, true);
  assert.strictEqual(inc.id, `user:${incomplete.id}`);
  assert.strictEqual(inc.is_verified, false);
  assert.ok(!byUser(archived.id), "archived drivers stay out of the default list");
  console.log("  ok  registered drivers show, including incomplete signups");

  const arch = await call("/api/admin/drivers?archived=1", ops);
  assert.ok(arch.body.drivers.some((d) => d.user_id === archived.id), "archived list has the archived driver");
  assert.ok(!arch.body.drivers.some((d) => d.user_id === incomplete.id), "and not the incomplete signup");
  console.log("  ok  archived view only has archived drivers");

  for (const [path, method] of [[`/api/admin/drivers/user:${incomplete.id}/verify`, "PATCH"], [`/api/admin/drivers/user:${incomplete.id}/archive`, "PATCH"]]) {
    const r = await call(path, adm, method);
    assert.strictEqual(r.status, 409, `${method} ${path} is refused clearly`);
    assert.ok(/not finished their driver profile/.test(r.body.error));
  }
  console.log("  ok  an incomplete signup cannot be verified or archived by mistake");

  console.log("done");
})()
  .catch((e) => { console.error("FAIL", e); process.exitCode = 1; })
  .finally(async () => {
    try {
      if (made.length) {
        await pool.query("DELETE FROM drivers WHERE user_id = ANY($1)", [made]);
        await pool.query("DELETE FROM users WHERE id = ANY($1)", [made]);
      }
    } catch (_) {}
    server.close(); await pool.end().catch(() => {});
  });
