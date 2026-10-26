// Owner and staff management against a REAL Postgres.
//   DATABASE_URL=postgres://... node routes/staffPeople.integration.test.js
const assert = require("assert");
const http = require("http");
const jwt = require("jsonwebtoken");
process.env.JWT_SECRET = process.env.JWT_SECRET || "integration-test-secret";
const express = require("express");
require("express-async-errors");
const { pool, ready } = require("../db/db");
const people = require("./staffPeople");
const staffRouter = require("./staffRides");

let passed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.log(`FAIL  ${name}\n      ${e.stack.split("\n").slice(0, 3).join("\n      ")}`); process.exitCode = 1; }
}
const app = express(); app.use(express.json());
app.use("/api/staff/people", people); app.use("/api/staff", staffRouter);
app.use((err, req, res, next) => res.status(500).json({ error: "server error", detail: err.message }));
const server = http.createServer(app);
async function api(path, { method = "GET", as, body } = {}) {
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers: { "Content-Type": "application/json", ...(as ? { Authorization: `Bearer ${as.token}` } : {}) },
    body: body === undefined || method === "GET" ? undefined : JSON.stringify(body) });
  const text = await res.text(); let json = {}; try { json = JSON.parse(text); } catch (_) {}
  return { status: res.status, body: json, text };
}
const stamp = Date.now(); let seq = 0; const made = [];
const tokenFor = (id, role, tv = 0) => jwt.sign({ id, email: `u${id}@example.com`, role, tv }, process.env.JWT_SECRET, { algorithm: "HS256" });
async function mk(role, { owner = false, manage = false, lead = false } = {}) {
  seq++;
  const r = await pool.query(
    `INSERT INTO users (name, email, phone, password_hash, role, is_owner, can_manage_staff, support_lead)
     VALUES ($1,$2,$3,'x',$4,$5,$6,$7) RETURNING id`,
    [`${role}${seq} Person`, `pp-${role}-${seq}-${stamp}@example.com`, `+23482${String(2000000 + seq)}`, role, owner, manage, lead]);
  const id = r.rows[0].id; made.push(id);
  return { id, role, email: `pp-${role}-${seq}-${stamp}@example.com`, token: tokenFor(id, role) };
}
const roleOf = async (id) => (await pool.query("SELECT role, token_version, support_lead, can_manage_staff FROM users WHERE id=$1", [id])).rows[0];

(async () => {
  // Requiring db/db starts the idempotent schema script. Wait for it, or the first
  // inserts below race its ALTER TABLE statements and Postgres reports a deadlock.
  await require("../db/db").ready;
await ready;
await pool.query("UPDATE staff_duty SET on_duty=false");
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const owner = await mk("admin", { owner: true });
const dele = await mk("admin", { manage: true });
const plain = await mk("admin");
const lead = await mk("support", { lead: true });
const sup = await mk("support");
const ops = await mk("operations");
const rider = await mk("rider");
const driver = await mk("driver");

console.log("viewing:");
await test("owner, delegated admin, plain admin and head of support can see the list; others cannot", async () => {
  for (const u of [owner, dele, plain, lead]) assert.strictEqual((await api("/api/staff/people", { as: u })).status, 200);
  for (const u of [sup, ops, rider]) assert.strictEqual((await api("/api/staff/people", { as: u })).status, 403);
  assert.strictEqual((await api("/api/staff/people")).status, 401);
});
await test("the list says who you are and what you may do", async () => {
  const o = await api("/api/staff/people", { as: owner });
  assert.deepStrictEqual(o.body.me, { id: owner.id, isOwner: true, canManage: true });
  assert.strictEqual((await api("/api/staff/people", { as: plain })).body.me.canManage, false);
  assert.strictEqual((await api("/api/staff/people", { as: dele })).body.me.canManage, true);
  assert.ok(o.body.people.some((p) => p.id === sup.id));
  assert.ok(!o.body.people.some((p) => p.id === rider.id));
});

console.log("promote and remove:");
await test("owner promotes an existing rider by email to support; they start off duty", async () => {
  const p = await mk("rider");
  const r = await api("/api/staff/people/promote", { method: "POST", as: owner, body: { email: p.email.toUpperCase(), role: "support" } });
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual((await roleOf(p.id)).role, "support");
  const sd = (await pool.query("SELECT on_duty, team FROM staff_duty WHERE user_id=$1", [p.id])).rows[0];
  assert.deepStrictEqual(sd, { on_duty: false, team: "support" });
});
await test("promoting an unknown email is a clear 404; a driver is refused", async () => {
  assert.strictEqual((await api("/api/staff/people/promote", { method: "POST", as: owner, body: { email: "nobody@example.com", role: "support" } })).status, 404);
  assert.strictEqual((await api("/api/staff/people/promote", { method: "POST", as: owner, body: { email: driver.email, role: "support" } })).status, 409);
  assert.strictEqual((await api("/api/staff/people/promote", { method: "POST", as: owner, body: { email: rider.email, role: "root" } })).status, 400);
});

await test(
"owner provisions a new RideArrivo company email directly as support",
async () => {
  const email = `new-support-${stamp}@ridearrivo.com`;

  const r = await api(
    "/api/staff/people/promote",
    {
      method: "POST",
      as: owner,
      body: {
        email,
        role: "support",
        name: "New Support Agent",
      },
    }
  );

  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(r.body.created, true);
  assert.strictEqual(r.body.to, "support");
  assert.strictEqual(r.body.setupRequired, true);

  const created = (
    await pool.query(
      `SELECT
         id,
         name,
         email,
         role,
         reset_token,
         reset_token_expires
       FROM users
       WHERE email = $1`,
      [email]
    )
  ).rows[0];

  assert.ok(created);
  assert.strictEqual(created.name, "New Support Agent");
  assert.strictEqual(created.email, email);
  assert.strictEqual(created.role, "support");
  assert.ok(created.reset_token);
  assert.ok(created.reset_token_expires);

  const duty = (
    await pool.query(
      `SELECT team, on_duty
       FROM staff_duty
       WHERE user_id = $1`,
      [created.id]
    )
  ).rows[0];

  assert.deepStrictEqual(duty, {
    team: "support",
    on_duty: false,
  });

  made.push(created.id);
}
);
await test("changing role signs the person out everywhere (old token stops working)", async () => {
  const p = await mk("support");
  const before = await roleOf(p.id);
  const r = await api(`/api/staff/people/${p.id}/role`, { method: "PUT", as: owner, body: { role: "operations" } });
  assert.strictEqual(r.status, 200, r.text);
  const after = await roleOf(p.id);
  assert.strictEqual(after.role, "operations"); assert.ok(after.token_version > before.token_version);
  assert.strictEqual((await api("/api/staff/duty", { as: { token: tokenFor(p.id, "support", before.token_version) } })).status, 401);
  assert.strictEqual((await pool.query("SELECT team FROM staff_duty WHERE user_id=$1", [p.id])).rows[0].team, "operations");
});
await test("removing the head of support clears the lead flag and hands their open rides on", async () => {
  const other = await mk("support"); const l = await mk("support", { lead: true });
  await pool.query("INSERT INTO staff_duty (user_id, team, on_duty) VALUES ($1,'support',true),($2,'support',true) ON CONFLICT (user_id) DO UPDATE SET on_duty=true", [other.id, l.id]);
  const rd = await mk("rider");
  const ride = (await pool.query("INSERT INTO rides (rider_id, pickup_address, fare_naira, ride_status) VALUES ($1,'Lekki',9000,'requested') RETURNING id", [rd.id])).rows[0].id;
  await pool.query("UPDATE ride_team SET support_user_id=$2 WHERE ride_id=$1", [ride, l.id]);
  const r = await api(`/api/staff/people/${l.id}/role`, { method: "PUT", as: owner, body: { role: "rider" } });
  assert.strictEqual(r.status, 200, r.text);
  const after = await roleOf(l.id); assert.strictEqual(after.role, "rider"); assert.strictEqual(after.support_lead, false);
  assert.strictEqual((await pool.query("SELECT support_user_id FROM ride_team WHERE ride_id=$1", [ride])).rows[0].support_user_id, other.id);
  await pool.query("UPDATE rides SET ride_status='cancelled' WHERE id=$1", [ride]);
  await pool.query("UPDATE staff_duty SET on_duty=false WHERE user_id=ANY($1)", [[other.id, l.id]]);
});

console.log("limits:");
await test("nobody can change their own role; the owner cannot be touched", async () => {
  assert.strictEqual((await api(`/api/staff/people/${owner.id}/role`, { method: "PUT", as: owner, body: { role: "support" } })).status, 403);
  assert.strictEqual((await api(`/api/staff/people/${owner.id}/role`, { method: "PUT", as: dele, body: { role: "support" } })).status, 403);
  assert.strictEqual((await roleOf(owner.id)).role, "admin");
});
await test("delegated admin manages support and operations but cannot make, move or remove admins", async () => {
  const p = await mk("rider");
  assert.strictEqual((await api("/api/staff/people/promote", { method: "POST", as: dele, body: { email: p.email, role: "operations" } })).status, 200);
  assert.strictEqual((await api("/api/staff/people/promote", { method: "POST", as: dele, body: { email: rider.email, role: "admin" } })).status, 403);
  assert.strictEqual((await api(`/api/staff/people/${plain.id}/role`, { method: "PUT", as: dele, body: { role: "rider" } })).status, 403);
  assert.strictEqual((await roleOf(plain.id)).role, "admin");
  assert.strictEqual((await api(`/api/staff/people/${p.id}/role`, { method: "PUT", as: dele, body: { role: "rider" } })).status, 200);
});
await test("plain admin, head of support, support, operations cannot change anything", async () => {
  const p = await mk("rider");
  for (const u of [plain, lead, sup, ops, rider]) {
    const r = await api("/api/staff/people/promote", { method: "POST", as: u, body: { email: p.email, role: "support" } });
    assert.strictEqual(r.status, 403, `${u.role}: ${r.text}`);
    const r2 = await api(`/api/staff/people/${sup.id}/role`, { method: "PUT", as: u, body: { role: "rider" } });
    assert.strictEqual(r2.status, 403);
  }
  assert.strictEqual((await roleOf(p.id)).role, "rider");
});
await test("only the owner grants and revokes the delegated privilege, only to admins", async () => {
  assert.strictEqual((await api(`/api/staff/people/${plain.id}/manage`, { method: "PUT", as: owner, body: { allowed: true } })).status, 200);
  assert.strictEqual((await roleOf(plain.id)).can_manage_staff, true);
  assert.strictEqual((await api(`/api/staff/people/${plain.id}/manage`, { method: "PUT", as: owner, body: { allowed: false } })).status, 200);
  assert.strictEqual((await api(`/api/staff/people/${plain.id}/manage`, { method: "PUT", as: dele, body: { allowed: true } })).status, 403);
  assert.strictEqual((await api(`/api/staff/people/${sup.id}/manage`, { method: "PUT", as: owner, body: { allowed: true } })).status, 409);
  assert.strictEqual((await api(`/api/staff/people/${plain.id}/manage`, { method: "PUT", as: owner, body: { allowed: "yes" } })).status, 400);
});
await test("demoting an admin also drops their delegated privilege", async () => {
  const a = await mk("admin", { manage: true });
  assert.strictEqual((await api(`/api/staff/people/${a.id}/role`, { method: "PUT", as: owner, body: { role: "support" } })).status, 200);
  assert.strictEqual((await roleOf(a.id)).can_manage_staff, false);
});
await test("bad ids and bodies are 400, not crashes", async () => {
  assert.strictEqual((await api("/api/staff/people/abc/role", { method: "PUT", as: owner, body: { role: "support" } })).status, 400);
  assert.strictEqual((await api(`/api/staff/people/${rider.id}/role`, { method: "PUT", as: owner, body: {} })).status, 400);
  assert.strictEqual((await api("/api/staff/people/promote", { method: "POST", as: owner, body: {} })).status, 400);
  assert.strictEqual((await api("/api/staff/people/99999999/role", { method: "PUT", as: owner, body: { role: "support" } })).status, 404);
});
await test("concurrent opposite changes to one person leave a valid state and both are logged or refused", async () => {
  const p = await mk("rider");
  const rs = await Promise.all([
    api(`/api/staff/people/${p.id}/role`, { method: "PUT", as: owner, body: { role: "support" } }),
    api(`/api/staff/people/${p.id}/role`, { method: "PUT", as: dele, body: { role: "operations" } }),
  ]);
  assert.ok(rs.every((r) => [200, 409].includes(r.status)), rs.map((r) => r.status).join());
  assert.ok(["support", "operations"].includes((await roleOf(p.id)).role));
});

console.log("audit trail:");
await test("every change is in the log with who, whom, from and to", async () => {
  const e = await api("/api/staff/people/events", { as: owner });
  assert.strictEqual(e.status, 200);
  const ev = e.body.events;
  assert.ok(ev.some((x) => x.action === "promote" && x.to_role === "support" && x.actor_name));
  assert.ok(ev.some((x) => x.action === "remove" && x.to_role === "rider"));
  assert.ok(ev.some((x) => x.action === "grant_manage") && ev.some((x) => x.action === "revoke_manage"));
  assert.strictEqual((await api("/api/staff/people/events", { as: sup })).status, 403);
});

await pool.query("DELETE FROM staff_role_events WHERE actor_id = ANY($1) OR target_id = ANY($1)", [made]);
await pool.query("DELETE FROM rides WHERE rider_id = ANY($1)", [made]);
await pool.query("DELETE FROM users WHERE id = ANY($1)", [made]);
server.close();
console.log(`\n${passed} passed`);
await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
