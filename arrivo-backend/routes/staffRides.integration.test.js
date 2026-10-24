// Ride teams and the staff Rides section, against a REAL Postgres.
//   DATABASE_URL=postgres://... node routes/staffRides.integration.test.js
// Covers the load balancer (fair, concurrent, reacts to duty changes), the
// head-of-support powers, number access logging and staff calling by name.
// Stream is a recording fake. Aimed at a throwaway database: it switches every
// existing staff member off duty so the numbers are exact.

const assert = require("assert");
const http = require("http");
const jwt = require("jsonwebtoken");

process.env.JWT_SECRET = process.env.JWT_SECRET || "integration-test-secret";
process.env.STREAM_API_KEY = "test-key";

const express = require("express");
require("express-async-errors");
const { pool, ready } = require("../db/db");
const callsRouter = require("./calls");
const staffRouter = require("./staffRides");

let passed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.log(`FAIL  ${name}\n      ${e.stack.split("\n").slice(0, 3).join("\n      ")}`); process.exitCode = 1; }
}

const fake = { created: [], upserts: [], pushes: [] };
const reset = () => { fake.created = []; fake.upserts = []; };
callsRouter.__setStreamClientsForTests(() => ({
  video: {
    upsertUsers: async (u) => { fake.upserts.push(...u); },
    call: (type, id) => ({ getOrCreate: async (opts) => { fake.created.push({ type, id, opts }); } }),
    generateCallToken: (o) => `tok-${o.user_id}`,
    generateUserToken: () => "u",
  },
  chat: { upsertUser: async () => {}, createToken: () => "c" },
}));

const app = express();
app.use(express.json());
app.use("/api/calls", callsRouter);
app.use("/api/staff", staffRouter);
app.use((err, req, res, next) => res.status(500).json({ error: "server error", detail: err.message }));
const server = http.createServer(app);

async function api(path, { method = "GET", as, body } = {}) {
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
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
const made = [];
async function mkUser(role, { phone, lead = false, name } = {}) {
  seq++;
  const r = await pool.query(
    "INSERT INTO users (name, email, phone, password_hash, role, support_lead) VALUES ($1,$2,$3,'x',$4,$5) RETURNING id",
    [name || `${role[0].toUpperCase()}${role.slice(1)}${seq} Surname`, `st-${role}-${seq}-${stamp}@example.com`, phone || `+23481${String(1000000 + seq).slice(1)}${seq}`, role, lead]
  );
  const id = r.rows[0].id; made.push(id);
  return { id, role, token: jwt.sign({ id, email: `u${id}@example.com`, role, tv: 0 }, process.env.JWT_SECRET, { algorithm: "HS256" }) };
}
const duty = (u, onDuty, extra = {}) => api("/api/staff/duty", { method: "PUT", as: u, body: { onDuty, ...extra } });
async function mkRide(status = "requested", { riderId, driverUserId } = {}) {
  const rider = riderId ? { id: riderId } : await mkUser("rider", {});
  let driverRow = null;
  if (driverUserId) driverRow = (await pool.query("SELECT id FROM drivers WHERE user_id=$1", [driverUserId])).rows[0].id;
  const r = await pool.query(
    "INSERT INTO rides (rider_id, driver_id, pickup_address, fare_naira, ride_status) VALUES ($1,$2,'Lekki',9000,$3) RETURNING id",
    [rider.id, driverRow, status]
  );
  return { id: r.rows[0].id, riderId: rider.id };
}
async function mkDriver() {
  const u = await mkUser("driver", {});
  await pool.query("INSERT INTO drivers (user_id, is_verified) VALUES ($1,true)", [u.id]);
  return u;
}
const team = async (rideId) => (await pool.query("SELECT * FROM ride_team WHERE ride_id=$1", [rideId])).rows[0];
async function loadOf(users, col) {
  const out = {};
  for (const u of users) {
    out[u.id] = (await pool.query(
      `SELECT count(*)::int n FROM ride_team rt JOIN rides r ON r.id=rt.ride_id WHERE rt.${col}=$1 AND r.ride_status NOT IN ('completed','cancelled')`, [u.id])).rows[0].n;
  }
  return out;
}

(async () => {
  // Requiring db/db starts the idempotent schema script. Wait for it, or the first
  // inserts below race its ALTER TABLE statements and Postgres reports a deadlock.
  await require("../db/db").ready;
await ready;
await pool.query("UPDATE staff_duty SET on_duty = false");
await new Promise((r) => server.listen(0, "127.0.0.1", r));

console.log("load balancer:");
await test("a ride booked with nobody on duty is queued, then picked up when staff go on duty", async () => {
  const ride = await mkRide();
  let t = await team(ride.id);
  assert.ok(t, "ride_team row exists"); assert.strictEqual(t.support_user_id, null); assert.strictEqual(t.operations_user_id, null);
  const s = await mkUser("support"); const o = await mkUser("operations");
  const r1 = await duty(s, true); assert.strictEqual(r1.status, 200);
  await duty(o, true);
  t = await team(ride.id);
  assert.strictEqual(t.support_user_id, s.id); assert.strictEqual(t.operations_user_id, o.id);
  await duty(s, false); await duty(o, false);
  // clean: close that ride so it no longer counts
  await pool.query("UPDATE rides SET ride_status='cancelled' WHERE id=$1", [ride.id]);
});
await test("9 rides, 3 support, 2 operations: 3 each, and 5 split 4/5", async () => {
  await pool.query("UPDATE rides SET ride_status='cancelled' WHERE ride_status NOT IN ('completed','cancelled')");
  const sups = [await mkUser("support"), await mkUser("support"), await mkUser("support")];
  const ops = [await mkUser("operations"), await mkUser("operations")];
  for (const u of [...sups, ...ops]) await duty(u, true);
  for (let i = 0; i < 9; i++) await mkRide();
  assert.deepStrictEqual(Object.values(await loadOf(sups, "support_user_id")), [3, 3, 3]);
  const o = Object.values(await loadOf(ops, "operations_user_id")).sort();
  assert.deepStrictEqual(o, [4, 5]);
  for (const u of [...sups, ...ops]) await duty(u, false);
  await pool.query("UPDATE rides SET ride_status='cancelled' WHERE ride_status NOT IN ('completed','cancelled')");
});
await test("40 rides booked at the same instant spread evenly across 5 support and 3 operations", async () => {
  const sups = []; const ops = [];
  for (let i = 0; i < 5; i++) sups.push(await mkUser("support"));
  for (let i = 0; i < 3; i++) ops.push(await mkUser("operations"));
  for (const u of [...sups, ...ops]) await duty(u, true);
  const riders = []; for (let i = 0; i < 40; i++) riders.push(await mkUser("rider", {}));
  await Promise.all(riders.map((r) => mkRide("requested", { riderId: r.id })));
  const sl = Object.values(await loadOf(sups, "support_user_id")); const ol = Object.values(await loadOf(ops, "operations_user_id"));
  assert.strictEqual(sl.reduce((a, b) => a + b, 0), 40); assert.strictEqual(ol.reduce((a, b) => a + b, 0), 40);
  assert.ok(Math.max(...sl) - Math.min(...sl) <= 1, `support spread ${sl}`);
  assert.ok(Math.max(...ol) - Math.min(...ol) <= 1, `operations spread ${ol}`);
  for (const u of [...sups, ...ops]) await duty(u, false);
  await pool.query("UPDATE rides SET ride_status='cancelled' WHERE ride_status NOT IN ('completed','cancelled')");
});
await test("finished rides stop counting against someone", async () => {
  const a = await mkUser("support"); const b = await mkUser("support");
  await duty(a, true); await duty(b, true);
  const first = await mkRide(); const second = await mkRide();
  const loser = (await team(first.id)).support_user_id;
  await pool.query("UPDATE rides SET ride_status='completed' WHERE id = ANY($1)", [[first.id, second.id]]);
  const next = await mkRide(); const third = await mkRide();
  assert.deepStrictEqual(Object.values(await loadOf([a, b], "support_user_id")).sort(), [1, 1]);
  assert.ok(loser);
  await duty(a, false); await duty(b, false);
  await pool.query("UPDATE rides SET ride_status='cancelled' WHERE ride_status NOT IN ('completed','cancelled')");
});
await test("going off duty hands that person's open rides to others; coming back takes new work only", async () => {
  const a = await mkUser("support"); const b = await mkUser("support");
  await duty(a, true); await duty(b, true);
  for (let i = 0; i < 4; i++) await mkRide();
  assert.deepStrictEqual(Object.values(await loadOf([a, b], "support_user_id")), [2, 2]);
  const r = await duty(a, false);
  assert.ok(r.body.moved >= 2);
  assert.deepStrictEqual(await loadOf([a, b], "support_user_id"), { [a.id]: 0, [b.id]: 4 });
  const ev = await pool.query("SELECT kind FROM ride_team_events WHERE from_user_id=$1 AND kind='reassigned'", [a.id]);
  assert.strictEqual(ev.rows.length, 2);
  await duty(a, true);
  assert.deepStrictEqual(await loadOf([a, b], "support_user_id"), { [a.id]: 0, [b.id]: 4 }); // no churn
  await mkRide(); await mkRide();
  assert.deepStrictEqual(await loadOf([a, b], "support_user_id"), { [a.id]: 2, [b.id]: 4 });
  await duty(a, false); await duty(b, false);
  await pool.query("UPDATE rides SET ride_status='cancelled' WHERE ride_status NOT IN ('completed','cancelled')");
});
await test("last person off duty leaves rides queued, an unassigned event is kept, and returning re-staffs", async () => {
  const a = await mkUser("support"); await duty(a, true);
  const ride = await mkRide();
  assert.strictEqual((await team(ride.id)).support_user_id, a.id);
  await duty(a, false);
  assert.strictEqual((await team(ride.id)).support_user_id, null);
  assert.ok((await pool.query("SELECT 1 FROM ride_team_events WHERE ride_id=$1 AND kind='unassigned'", [ride.id])).rows.length === 1);
  await duty(a, true);
  assert.strictEqual((await team(ride.id)).support_user_id, a.id);
  await duty(a, false);
  await pool.query("UPDATE rides SET ride_status='cancelled' WHERE ride_status NOT IN ('completed','cancelled')");
});
await test("a deleted account is replaced by the sweep", async () => {
  const a = await mkUser("support"); const b = await mkUser("support");
  await duty(a, true);
  const ride = await mkRide(); assert.strictEqual((await team(ride.id)).support_user_id, a.id);
  await duty(b, true);
  await pool.query("UPDATE users SET deleted_at = now() WHERE id=$1", [a.id]);
  const n = (await pool.query("SELECT rebalance_ride_teams('sweep') n")).rows[0].n;
  assert.ok(n >= 1); assert.strictEqual((await team(ride.id)).support_user_id, b.id);
  assert.strictEqual((await pool.query("SELECT rebalance_ride_teams('sweep') n")).rows[0].n, 0, "second sweep has nothing to do");
  await duty(b, false);
  await pool.query("UPDATE rides SET ride_status='cancelled' WHERE ride_status NOT IN ('completed','cancelled')");
});
await test("soft cap: someone at their limit is passed over while others have room", async () => {
  const a = await mkUser("support"); const b = await mkUser("support");
  await duty(a, true, { maxOpen: 1 }); await duty(b, true);
  const rides = []; for (let i = 0; i < 5; i++) rides.push(await mkRide());
  const l = await loadOf([a, b], "support_user_id");
  assert.strictEqual(l[a.id], 1); assert.strictEqual(l[b.id], 4);
  await duty(a, false); await duty(b, false);
  await pool.query("UPDATE rides SET ride_status='cancelled' WHERE ride_status NOT IN ('completed','cancelled')");
});

console.log("who may do what:");
const sup = await mkUser("support"); const lead = await mkUser("support", { lead: true }); const ops = await mkUser("operations");
const admin = await mkUser("admin"); const rider = await mkUser("rider", {});
await test("riders and drivers cannot touch staff endpoints", async () => {
  const drv = await mkDriver();
  for (const u of [rider, drv]) {
    for (const [m, p] of [["GET", "/api/staff/rides"], ["GET", "/api/staff/duty"], ["GET", "/api/staff/team"], ["GET", "/api/staff/access-log"]]) {
      assert.strictEqual((await api(p, { method: m, as: u })).status, 403, `${u.role} ${p}`);
    }
  }
  assert.strictEqual((await api("/api/staff/rides")).status, 401);
});
await test("duty: validation, role/team match, and who can change whose", async () => {
  assert.strictEqual((await duty(sup, "yes")).status, 400);
  assert.strictEqual((await duty(sup, true, { team: "operations" })).status, 403);
  assert.strictEqual((await duty(ops, true, { team: "support" })).status, 403);
  assert.strictEqual((await duty(admin, true, { team: "support" })).status, 200);
  assert.strictEqual((await duty(admin, false)).status, 200);
  // a support agent cannot switch another on or off
  assert.strictEqual((await duty(sup, true, { userId: lead.id })).status, 403);
  // the head of support can, for support agents
  assert.strictEqual((await duty(lead, true, { userId: sup.id })).status, 200);
  assert.strictEqual((await duty(lead, false, { userId: sup.id })).status, 200);
  // but not for operations
  assert.strictEqual((await duty(lead, true, { userId: ops.id })).status, 403);
  // admin can for anyone, and a missing person is 404
  assert.strictEqual((await duty(admin, true, { userId: ops.id })).status, 200);
  assert.strictEqual((await duty(admin, false, { userId: ops.id })).status, 200);
  assert.strictEqual((await duty(admin, true, { userId: 999999999 })).status, 404);
  assert.strictEqual((await duty(admin, true, { userId: rider.id })).status, 404);
});
await test("only an admin names the head of support, and only a support user can be one", async () => {
  const other = await mkUser("support");
  assert.strictEqual((await api(`/api/staff/lead/${other.id}`, { method: "PUT", as: lead, body: { isLead: true } })).status, 403);
  assert.strictEqual((await api(`/api/staff/lead/${ops.id}`, { method: "PUT", as: admin, body: { isLead: true } })).status, 409);
  assert.strictEqual((await api(`/api/staff/lead/${other.id}`, { method: "PUT", as: admin, body: { isLead: "yes" } })).status, 400);
  assert.strictEqual((await api(`/api/staff/lead/${other.id}`, { method: "PUT", as: admin, body: { isLead: true } })).status, 200);
  assert.strictEqual((await api("/api/staff/duty", { as: other })).body.isLead, true);
  assert.strictEqual((await api(`/api/staff/lead/${other.id}`, { method: "PUT", as: admin, body: { isLead: false } })).status, 200);
});

console.log("the Rides section:");
let drvA, rideA, agentA, opsA;
await test("lists: mine by default, all and unassigned on request, numbers hidden to a hint", async () => {
  await pool.query("UPDATE rides SET ride_status='cancelled' WHERE ride_status NOT IN ('completed','cancelled')");
  agentA = await mkUser("support", { name: "Tola Bankole" }); opsA = await mkUser("operations", { name: "Chidi Okafor" });
  await duty(agentA, true); await duty(opsA, true);
  drvA = await mkDriver();
  await pool.query("UPDATE users SET name='Ibrahim Musa', phone='+2348055500123' WHERE id=$1", [drvA.id]);
  rideA = await mkRide("accepted", { driverUserId: drvA.id });
  await pool.query("UPDATE users SET name='Ada Nwosu', phone='+2348077700456' WHERE id=$1", [rideA.riderId]);
  const mine = await api("/api/staff/rides", { as: agentA });
  assert.strictEqual(mine.status, 200); assert.strictEqual(mine.body.scope, "mine");
  assert.ok(mine.body.rides.some((r) => r.id === rideA.id));
  const r = mine.body.rides.find((x) => x.id === rideA.id);
  assert.strictEqual(r.rider.firstName, "Ada"); assert.strictEqual(r.driver.firstName, "Ibrahim");
  assert.strictEqual(r.team.support.firstName, "Tola"); assert.strictEqual(r.team.operations.firstName, "Chidi");
  assert.ok(!mine.text.includes("2348077700456") && !mine.text.includes("2348055500123"), "full numbers must not be in the list");
  assert.ok(r.rider.phoneHint.endsWith("456"));
  const other = await mkUser("support"); // not on duty, owns nothing
  assert.strictEqual((await api("/api/staff/rides", { as: other })).body.rides.length, 0);
  assert.ok((await api("/api/staff/rides?scope=all", { as: other })).body.rides.some((x) => x.id === rideA.id));
  assert.ok((await api("/api/staff/rides?scope=all&q=nwosu", { as: other })).body.rides.some((x) => x.id === rideA.id));
  assert.ok((await api(`/api/staff/rides?scope=all&q=${rideA.id}`, { as: other })).body.rides.some((x) => x.id === rideA.id));
  assert.strictEqual((await api("/api/staff/rides?scope=all&q=%27%3B%20drop%20table%20users%3B--", { as: other })).status, 200);
  assert.ok(!(await api("/api/staff/rides?scope=unassigned", { as: other })).body.rides.some((x) => x.id === rideA.id));
  const closed = await api("/api/staff/rides?scope=all&state=closed", { as: other });
  assert.ok(!closed.body.rides.some((x) => x.id === rideA.id));
});
await test("detail: full profiles with numbers, team, history, and the sighting is logged once per 10 minutes", async () => {
  const d = await api(`/api/staff/rides/${rideA.id}`, { as: agentA });
  assert.strictEqual(d.status, 200);
  assert.strictEqual(d.body.rider.phone, "+2348077700456"); assert.strictEqual(d.body.driver.phone, "+2348055500123");
  assert.strictEqual(d.body.rider.firstName, "Ada"); assert.strictEqual(d.body.team.support.firstName, "Tola");
  assert.ok(Array.isArray(d.body.history) && d.body.history.length >= 2);
  await api(`/api/staff/rides/${rideA.id}`, { as: agentA });
  const logged = await pool.query("SELECT count(*)::int n FROM staff_contact_access WHERE staff_user_id=$1 AND ride_id=$2 AND action='view_number'", [agentA.id, rideA.id]);
  assert.strictEqual(logged.rows[0].n, 2, "one row for rider and one for driver, not four");
  await pool.query("UPDATE staff_contact_access SET created_at = now() - interval '11 minutes' WHERE staff_user_id=$1", [agentA.id]);
  await api(`/api/staff/rides/${rideA.id}`, { as: agentA });
  assert.strictEqual((await pool.query("SELECT count(*)::int n FROM staff_contact_access WHERE staff_user_id=$1", [agentA.id])).rows[0].n, 4);
  assert.strictEqual((await api("/api/staff/rides/0", { as: agentA })).status, 400);
  assert.strictEqual((await api("/api/staff/rides/99999999", { as: agentA })).status, 404);
  assert.strictEqual((await api("/api/staff/rides/abc", { as: agentA })).status, 400);
});
await test("a ride without a driver shows no driver; contact-log validates and records", async () => {
  const bare = await mkRide("requested");
  const d = await api(`/api/staff/rides/${bare.id}`, { as: admin });
  assert.strictEqual(d.body.driver, null);
  assert.strictEqual((await api(`/api/staff/rides/${bare.id}/contact-log`, { method: "POST", as: agentA, body: { subject: "driver", action: "call_from_phone" } })).status, 409);
  for (const bad of [{}, { subject: "x", action: "call_from_phone" }, { subject: "rider", action: "delete" }]) {
    assert.strictEqual((await api(`/api/staff/rides/${rideA.id}/contact-log`, { method: "POST", as: agentA, body: bad })).status, 400);
  }
  assert.strictEqual((await api(`/api/staff/rides/${rideA.id}/contact-log`, { method: "POST", as: agentA, body: { subject: "rider", action: "call_from_phone" } })).status, 201);
  assert.strictEqual((await api(`/api/staff/rides/${rideA.id}/contact-log`, { method: "POST", as: agentA, body: { subject: "rider", action: "call_from_phone" } })).status, 201);
  assert.strictEqual((await pool.query("SELECT count(*)::int n FROM staff_contact_access WHERE ride_id=$1 AND action='call_from_phone'", [rideA.id])).rows[0].n, 2, "every phone call is logged, none merged");
  assert.strictEqual((await api(`/api/staff/rides/99999999/contact-log`, { method: "POST", as: agentA, body: { subject: "rider", action: "call_from_phone" } })).status, 404);
});
await test("team view shows load and what is waiting; access log is for the head of support and admin only", async () => {
  const t = await api("/api/staff/team", { as: sup });
  assert.strictEqual(t.status, 200); assert.ok(t.body.staff.some((s) => s.userId === agentA.id && s.onDuty && s.openRides >= 1));
  assert.strictEqual((await api("/api/staff/access-log", { as: sup })).status, 403);
  assert.strictEqual((await api("/api/staff/access-log", { as: ops })).status, 403);
  const l = await api("/api/staff/access-log", { as: lead });
  assert.strictEqual(l.status, 200); assert.ok(l.body.entries.length >= 1);
  assert.strictEqual((await api("/api/staff/access-log", { as: admin })).status, 200);
});

console.log("head of support moves rides:");
await test("a plain agent cannot move rides; the head can for support, not for operations; admin can for both", async () => {
  const b = await mkUser("support", { name: "Funmi Adeyemi" }); await duty(b, true);
  const off = await mkUser("support"); // never on duty
  const body = { team: "support", userId: b.id };
  assert.strictEqual((await api(`/api/staff/rides/${rideA.id}/reassign`, { method: "POST", as: agentA, body })).status, 403);
  assert.strictEqual((await api(`/api/staff/rides/${rideA.id}/reassign`, { method: "POST", as: lead, body: { team: "support", userId: off.id } })).status, 409);
  const ok = await api(`/api/staff/rides/${rideA.id}/reassign`, { method: "POST", as: lead, body });
  assert.strictEqual(ok.status, 200); assert.strictEqual(ok.body.changed, true);
  assert.strictEqual((await team(rideA.id)).support_user_id, b.id);
  assert.strictEqual((await api(`/api/staff/rides/${rideA.id}/reassign`, { method: "POST", as: lead, body })).body.changed, false);
  // the move sticks through a sweep
  await pool.query("SELECT rebalance_ride_teams('sweep')");
  assert.strictEqual((await team(rideA.id)).support_user_id, b.id);
  assert.strictEqual((await api(`/api/staff/rides/${rideA.id}/reassign`, { method: "POST", as: lead, body: { team: "operations", userId: opsA.id } })).status, 403);
  assert.strictEqual((await api(`/api/staff/rides/${rideA.id}/reassign`, { method: "POST", as: admin, body: { team: "operations", userId: opsA.id } })).status, 200);
  assert.strictEqual((await api(`/api/staff/rides/99999999/reassign`, { method: "POST", as: admin, body })).status, 404);
  assert.strictEqual((await api(`/api/staff/rides/${rideA.id}/reassign`, { method: "POST", as: admin, body: { team: "x", userId: b.id } })).status, 400);
  const hist = await api(`/api/staff/rides/${rideA.id}`, { as: admin });
  assert.ok(hist.body.history.some((h) => h.kind === "reassigned" && h.to === "Funmi"));
  await api(`/api/staff/rides/${rideA.id}/reassign`, { method: "POST", as: admin, body: { team: "support", userId: agentA.id } });
});

console.log("calling by name:");
await test("the assigned agent rings the rider and the driver; the call shows their first name; it is recorded and logged", async () => {
  reset();
  const r = await api(`/api/calls/staff/ride/${rideA.id}/start`, { method: "POST", as: agentA, body: { target: "rider" } });
  assert.strictEqual(r.status, 201, r.text);
  assert.strictEqual(r.body.callee.firstName, "Ada"); assert.strictEqual(r.body.callee.role, "rider");
  assert.strictEqual(fake.created[0].opts.data.custom.callerName, "Tola from RideArrivo");
  assert.strictEqual(fake.upserts.find((u) => u.id === String(agentA.id)).name, "Tola (RideArrivo)");
  assert.strictEqual(fake.upserts.find((u) => u.id === String(agentA.id)).role, "admin");
  assert.ok(!r.text.includes("2348077700456"));
  const row = (await pool.query("SELECT * FROM call_sessions WHERE id=$1", [r.body.session.id])).rows[0];
  assert.strictEqual(row.placed_by_staff, true); assert.strictEqual(row.caller_user_id, agentA.id); assert.strictEqual(row.callee_user_id, rideA.riderId);
  assert.strictEqual((await pool.query("SELECT count(*)::int n FROM staff_contact_access WHERE action='call_in_app' AND ride_id=$1", [rideA.id])).rows[0].n, 1);
  // double tap is the same call; someone else calling the same person is told they are busy
  const again = await api(`/api/calls/staff/ride/${rideA.id}/start`, { method: "POST", as: agentA, body: { target: "rider" } });
  assert.strictEqual(again.status, 200); assert.strictEqual(again.body.session.id, r.body.session.id);
  const busy = await api(`/api/calls/staff/ride/${rideA.id}/start`, { method: "POST", as: opsA, body: { target: "rider" } });
  assert.strictEqual(busy.status, 409); assert.strictEqual(busy.body.code, "callee_busy");
  await api(`/api/calls/${r.body.session.id}/events`, { method: "POST", as: agentA, body: { event: "cancelled" } });
  const d = await api(`/api/calls/staff/ride/${rideA.id}/start`, { method: "POST", as: opsA, body: { target: "driver" } });
  assert.strictEqual(d.status, 201); assert.strictEqual(d.body.callee.firstName, "Ibrahim");
  assert.strictEqual(fake.created.at(-1).opts.data.custom.callerName, "Chidi from RideArrivo");
  await api(`/api/calls/${d.body.session.id}/events`, { method: "POST", as: opsA, body: { event: "cancelled" } });
});
await test("staff off the ride's team are refused; the head and admins are not; riders cannot use it", async () => {
  reset();
  const stranger = await mkUser("support");
  const refused = await api(`/api/calls/staff/ride/${rideA.id}/start`, { method: "POST", as: stranger, body: { target: "rider" } });
  assert.strictEqual(refused.status, 403); assert.strictEqual(refused.body.code, "not_on_team");
  const l = await api(`/api/calls/staff/ride/${rideA.id}/start`, { method: "POST", as: lead, body: { target: "driver" } });
  assert.strictEqual(l.status, 201);
  await api(`/api/calls/${l.body.session.id}/events`, { method: "POST", as: lead, body: { event: "cancelled" } });
  const a = await api(`/api/calls/staff/ride/${rideA.id}/start`, { method: "POST", as: admin, body: { target: "rider" } });
  assert.strictEqual(a.status, 201);
  await api(`/api/calls/${a.body.session.id}/events`, { method: "POST", as: admin, body: { event: "cancelled" } });
  assert.strictEqual((await api(`/api/calls/staff/ride/${rideA.id}/start`, { method: "POST", as: rider, body: { target: "driver" } })).status, 403);
  assert.strictEqual((await api(`/api/calls/staff/ride/${rideA.id}/start`, { method: "POST", as: agentA, body: { target: "pilot" } })).status, 400);
  const bare = await mkRide("requested");
  assert.strictEqual((await api(`/api/calls/staff/ride/${bare.id}/start`, { method: "POST", as: admin, body: { target: "driver" } })).body.code, "no_driver");
  assert.strictEqual((await api(`/api/calls/staff/ride/99999999/start`, { method: "POST", as: admin, body: { target: "rider" } })).status, 404);
});
await test("when a rider's call fails, 'Talk to Support' lands on that ride's own support agent", async () => {
  const rr = await api(`/api/calls/ride/${rideA.id}/start`, { method: "POST", as: { token: jwt.sign({ id: rideA.riderId, email: "r@example.com", role: "rider", tv: 0 }, process.env.JWT_SECRET) }, body: {} });
  assert.strictEqual(rr.status, 201, rr.text);
  const riderAsUser = { token: jwt.sign({ id: rideA.riderId, email: "r@example.com", role: "rider", tv: 0 }, process.env.JWT_SECRET) };
  const tk = await api(`/api/calls/${rr.body.session.id}/support`, { method: "POST", as: riderAsUser, body: { note: "no answer" } });
  assert.strictEqual(tk.status, 201);
  const row = (await pool.query("SELECT assigned_to FROM support_tickets WHERE id=$1", [tk.body.ticketId])).rows[0];
  assert.strictEqual(row.assigned_to, (await team(rideA.id)).support_user_id);
  const d = await api(`/api/staff/rides/${rideA.id}`, { as: agentA });
  assert.ok(d.body.tickets.some((t) => t.id === tk.body.ticketId && t.assignedTo === "Tola"));
  assert.ok(d.body.calls.length >= 1);
});

// cleanup
await pool.query("UPDATE staff_duty SET on_duty=false WHERE user_id = ANY($1)", [made]);
await pool.query("DELETE FROM staff_contact_access WHERE staff_user_id = ANY($1) OR subject_user_id = ANY($1)", [made]);
await pool.query("DELETE FROM support_tickets WHERE user_id = ANY($1)", [made]);
await pool.query("DELETE FROM rides WHERE rider_id = ANY($1)", [made]);
await pool.query("DELETE FROM drivers WHERE user_id = ANY($1)", [made]);
await pool.query("DELETE FROM users WHERE id = ANY($1)", [made]);
server.close();
console.log(`\n${passed} passed`);
await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
