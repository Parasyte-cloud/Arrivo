// The staff "Rides" section: every ride with its team (support agent, operations
// person, driver), the rider's and driver's profiles, and the means to reach them
// by name from the workspace or from the staff member's own phone.
//
//   Support agent / operations   their own rides by default, can look at any
//   Head of support              everything, moves rides between agents, sets duty
//   Admin                        everything, also names the head of support
//
// Phone numbers are only on the detail view and every sight of one is logged
// (staff_contact_access). The list shows the last three digits only.
const express = require("express");
const { pool } = require("../db/db");
const { requireAuth, requireAnyRole } = require("../middleware/auth");
const svc = require("../services/rideTeam");
const { logAccess } = require("../services/contactAccessLog");

const router = express.Router();
router.use(requireAuth, requireAnyRole(svc.STAFF_ROLES));

const parseId = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 2147483647 ? n : null;
};
const safeStops = (s) => { try { return JSON.parse(s || "[]"); } catch (_) { return []; } };
const OPEN = "('completed','cancelled')";

function rowToSummary(r) {
  return {
    id: r.id,
    status: r.ride_status,
    open: !["completed", "cancelled"].includes(r.ride_status),
    pickup: r.pickup_address,
    scheduledPickupAt: r.scheduled_pickup_at,
    createdAt: r.created_at,
    panic: !!r.panic_triggered_at && !r.panic_resolved_at,
    rider: { id: r.rider_id, name: r.rider_name, firstName: svc.firstName(r.rider_name), phoneHint: svc.phoneHint(r.rider_phone) },
    driver: r.driver_user_id
      ? { userId: r.driver_user_id, name: r.driver_name, firstName: svc.firstName(r.driver_name), phoneHint: svc.phoneHint(r.driver_phone) }
      : null,
    team: {
      support: r.support_user_id ? { id: r.support_user_id, name: r.support_name, firstName: svc.firstName(r.support_name) } : null,
      operations: r.operations_user_id ? { id: r.operations_user_id, name: r.operations_name, firstName: svc.firstName(r.operations_name) } : null,
    },
  };
}

function summarySql(extraCols = "", extraJoins = "") {
  return `
  SELECT ${extraCols} rides.id, rides.rider_id, rides.ride_status, rides.pickup_address, rides.scheduled_pickup_at, rides.created_at,
         rides.panic_triggered_at, rides.panic_resolved_at,
         rider.name AS rider_name, rider.phone AS rider_phone,
         du.id AS driver_user_id, du.name AS driver_name, du.phone AS driver_phone,
         rt.support_user_id, sup.name AS support_name, rt.operations_user_id, ops.name AS operations_name
  FROM rides
  JOIN users rider ON rider.id = rides.rider_id
  LEFT JOIN drivers d ON d.id = rides.driver_id
  LEFT JOIN users du ON du.id = d.user_id
  ${extraJoins}
  LEFT JOIN ride_team rt ON rt.ride_id = rides.id
  LEFT JOIN users sup ON sup.id = rt.support_user_id
  LEFT JOIN users ops ON ops.id = rt.operations_user_id
`;
}
const SUMMARY_SQL = summarySql();

// GET /api/staff/rides?scope=mine|all|unassigned&state=open|closed|all&q=
router.get("/rides", async (req, res) => {
  const scope = ["mine", "all", "unassigned"].includes(req.query.scope) ? req.query.scope : "mine";
  const state = ["open", "closed", "all"].includes(req.query.state) ? req.query.state : "open";
  const where = [];
  const params = [];
  if (scope === "mine") { params.push(req.user.id); where.push(`(rt.support_user_id = $${params.length} OR rt.operations_user_id = $${params.length})`); }
  if (scope === "unassigned") where.push("(rt.support_user_id IS NULL OR rt.operations_user_id IS NULL)");
  if (state === "open") where.push(`rides.ride_status NOT IN ${OPEN}`);
  if (state === "closed") where.push(`rides.ride_status IN ${OPEN}`);
  const q = String(req.query.q || "").trim().slice(0, 80);
  if (q) {
    params.push(`%${q.toLowerCase()}%`);
    const i = params.length;
    where.push(`(LOWER(rider.name) LIKE $${i} OR LOWER(COALESCE(du.name,'')) LIKE $${i} OR LOWER(rides.pickup_address) LIKE $${i} OR rides.id::text = $${i + 1})`);
    params.push(q.replace(/[^0-9]/g, "") || "-");
  }
  const sql = `${SUMMARY_SQL} ${where.length ? "WHERE " + where.join(" AND ") : ""}
               ORDER BY (rides.panic_triggered_at IS NOT NULL AND rides.panic_resolved_at IS NULL) DESC, rides.created_at DESC LIMIT 200`;
  const r = await pool.query(sql, params);
  const counts = await pool.query(
    `SELECT count(*) FILTER (WHERE rt.support_user_id = $1 OR rt.operations_user_id = $1)::int AS mine,
            count(*) FILTER (WHERE rt.support_user_id IS NULL OR rt.operations_user_id IS NULL)::int AS unassigned
     FROM rides LEFT JOIN ride_team rt ON rt.ride_id = rides.id
     WHERE rides.ride_status NOT IN ${OPEN}`,
    [req.user.id]
  );
  res.json({ scope, state, rides: r.rows.map(rowToSummary), counts: counts.rows[0] });
});


// GET /api/staff/rides/:id  full profile of the ride with numbers (logged)
router.get("/rides/:id", async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: "ride id must be a whole number" });
  const r = await pool.query(
    `${summarySql(
      `rides.stops, rides.fare_naira, rides.vehicle_type, rides.booking_type,
         rides.payment_status, rides.flight_number, rides.emergency_contact_name, rides.emergency_contact_phone, rides.updated_at,
         rider.email AS rider_email, rider.preferred_language AS rider_language, rider.created_at AS rider_since,
         d.rating AS driver_rating, veh.make_model, veh.plate_number, veh.vehicle_type AS vehicle_kind, du.email AS driver_email,`,
      "LEFT JOIN vehicles veh ON veh.id = d.vehicle_id"
    )}
     WHERE rides.id = $1`,
    [id]
  );
  const row = r.rows[0];
  if (!row) return res.status(404).json({ error: "Ride not found" });

  await logAccess(req.user.id, id, row.rider_id, "rider", "view_number");
  if (row.driver_user_id) {
    await logAccess(req.user.id, id, row.driver_user_id, "driver", "view_number");
  }
  if (row.emergency_contact_phone) {
    await logAccess(req.user.id, id, row.rider_id, "emergency_contact", "view_number");
  }

  const [calls, tickets, history, riderStats] = await Promise.all([
    pool.query(
      `SELECT cs.id, cs.status, cs.media, cs.created_at, cs.duration_seconds, cs.failure_reason, cs.placed_by_staff,
              caller.name AS caller_name, callee.name AS callee_name
       FROM call_sessions cs JOIN users caller ON caller.id = cs.caller_user_id JOIN users callee ON callee.id = cs.callee_user_id
       WHERE cs.ride_id = $1 ORDER BY cs.created_at DESC LIMIT 15`, [id]),
    pool.query(
      `SELECT t.id, t.subject, t.status, t.created_at, a.name AS assigned_name
       FROM support_tickets t LEFT JOIN users a ON a.id = t.assigned_to WHERE t.ride_id = $1 ORDER BY t.created_at DESC LIMIT 10`, [id]),
    pool.query(
      `SELECT e.team, e.kind, e.reason, e.created_at, f.name AS from_name, t.name AS to_name
       FROM ride_team_events e LEFT JOIN users f ON f.id = e.from_user_id LEFT JOIN users t ON t.id = e.to_user_id
       WHERE e.ride_id = $1 ORDER BY e.created_at DESC LIMIT 20`, [id]),
    pool.query(
      `SELECT count(*)::int AS rides, count(*) FILTER (WHERE ride_status = 'completed')::int AS completed
       FROM rides WHERE rider_id = $1`, [row.rider_id]),
  ]);

  const s = rowToSummary(row);
  res.json({
    ride: {
      ...s,
      stops: safeStops(row.stops),
      fareNaira: row.fare_naira,
      vehicleType: row.vehicle_type,
      bookingType: row.booking_type,
      paymentStatus: row.payment_status,
      flightNumber: row.flight_number,
      updatedAt: row.updated_at,
      emergencyContact: row.emergency_contact_name || row.emergency_contact_phone
        ? { name: row.emergency_contact_name, phone: row.emergency_contact_phone } : null,
    },
    rider: {
      id: row.rider_id, name: row.rider_name, firstName: svc.firstName(row.rider_name),
      phone: row.rider_phone, email: row.rider_email, language: row.rider_language, memberSince: row.rider_since,
      rides: riderStats.rows[0].rides, completedRides: riderStats.rows[0].completed,
    },
    driver: row.driver_user_id ? {
      userId: row.driver_user_id, name: row.driver_name, firstName: svc.firstName(row.driver_name),
      phone: row.driver_phone, email: row.driver_email, rating: row.driver_rating,
      vehicle: row.make_model ? { model: row.make_model, plate: row.plate_number, type: row.vehicle_kind } : null,
    } : null,
    team: s.team,
    canCall: { app: true },
    calls: calls.rows.map((c) => ({ id: c.id, status: c.status, media: c.media, at: c.created_at, seconds: c.duration_seconds, reason: c.failure_reason, byStaff: c.placed_by_staff, from: svc.firstName(c.caller_name), to: svc.firstName(c.callee_name) })),
    tickets: tickets.rows.map((t) => ({ id: t.id, subject: t.subject, status: t.status, at: t.created_at, assignedTo: svc.firstName(t.assigned_name) })),
    history: history.rows.map((h) => ({ team: h.team, kind: h.kind, reason: h.reason, at: h.created_at, from: svc.firstName(h.from_name), to: svc.firstName(h.to_name) })),
  });
});

// POST /api/staff/rides/:id/contact-log  { subject: "rider"|"driver", action: "call_from_phone" }
// The workspace calls this just before it opens tel: so a call from a staff
// member's own phone leaves a trace.
router.post("/rides/:id/contact-log", async (req, res) => {
  const id = parseId(req.params.id);
  const subject = req.body && req.body.subject;
  const action = req.body && req.body.action;
  if (!id || !["rider", "driver"].includes(subject) || !["call_from_phone", "view_number"].includes(action)) {
    return res.status(400).json({ error: "Need a ride, a subject (rider or driver) and an action." });
  }
  const r = await pool.query(
    `SELECT rides.rider_id, du.id AS driver_user_id FROM rides
     LEFT JOIN drivers d ON d.id = rides.driver_id LEFT JOIN users du ON du.id = d.user_id WHERE rides.id = $1`, [id]);
  const row = r.rows[0];
  if (!row) return res.status(404).json({ error: "Ride not found" });
  const subjectId = subject === "rider" ? row.rider_id : row.driver_user_id;
  if (!subjectId) return res.status(409).json({ error: "This ride has no driver yet." });
  // Calls are always logged; they are the thing worth counting.
  await pool.query(
    `INSERT INTO staff_contact_access (staff_user_id, ride_id, subject_user_id, subject_role, action) VALUES ($1,$2,$3,$4,$5)`,
    [req.user.id, id, subjectId, subject, action]
  );
  res.status(201).json({ ok: true });
});

// ── duty ──
router.get("/duty", async (req, res) => {
  res.json({ duty: await svc.getDuty(req.user.id), team: svc.defaultTeamFor(req.user.role), isLead: await svc.isLead(req.user.id) });
});

// PUT /api/staff/duty  { onDuty, team?, userId?, maxOpen? }
router.put("/duty", async (req, res) => {
  const b = req.body || {};
  if (typeof b.onDuty !== "boolean") return res.status(400).json({ error: "onDuty must be true or false" });
  let target = { id: req.user.id, role: req.user.role };
  if (b.userId != null && Number(b.userId) !== req.user.id) {
    if (!(await svc.canManage(req.user))) return res.status(403).json({ error: "Only the head of support or an admin can change someone else's duty." });
    const u = await pool.query("SELECT id, role FROM users WHERE id = $1 AND deleted_at IS NULL", [parseId(b.userId)]);
    if (!u.rows[0] || !svc.STAFF_ROLES.includes(u.rows[0].role)) return res.status(404).json({ error: "Staff member not found" });
    if (req.user.role !== "admin" && u.rows[0].role !== "support") return res.status(403).json({ error: "The head of support manages support agents." });
    target = u.rows[0];
  }
  try {
    const out = await svc.setDuty({ userId: target.id, role: target.role, onDuty: b.onDuty, team: b.team, maxOpen: b.maxOpen });
    res.json(out);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// GET /api/staff/team  everyone on a team, their load, and what is waiting
router.get("/team", async (req, res) => {
  const r = await pool.query(
    `SELECT sd.user_id, u.name, u.role, u.support_lead, sd.team, sd.on_duty, sd.max_open, staff_open_load(sd.user_id, sd.team) AS open_rides
     FROM staff_duty sd JOIN users u ON u.id = sd.user_id WHERE u.deleted_at IS NULL
     ORDER BY sd.team, sd.on_duty DESC, u.name`);
  const q = await pool.query(
    `SELECT count(*) FILTER (WHERE rt.support_user_id IS NULL)::int AS waiting_support,
            count(*) FILTER (WHERE rt.operations_user_id IS NULL)::int AS waiting_operations
     FROM rides LEFT JOIN ride_team rt ON rt.ride_id = rides.id WHERE rides.ride_status NOT IN ${OPEN}`);
  res.json({
    staff: r.rows.map((s) => ({ userId: s.user_id, name: s.name, firstName: svc.firstName(s.name), role: s.role, isLead: s.support_lead, team: s.team, onDuty: s.on_duty, maxOpen: s.max_open, openRides: s.open_rides })),
    waiting: q.rows[0],
  });
});

// POST /api/staff/rides/:id/reassign  { team: "support"|"operations", userId }
router.post("/rides/:id/reassign", async (req, res) => {
  if (!(await svc.canManage(req.user))) return res.status(403).json({ error: "Only the head of support or an admin can move a ride." });
  const id = parseId(req.params.id);
  const team = req.body && req.body.team;
  const userId = parseId(req.body && req.body.userId);
  if (!id || !["support", "operations"].includes(team) || !userId) return res.status(400).json({ error: "Need a ride, a team and a person." });
  if (team === "operations" && req.user.role !== "admin") return res.status(403).json({ error: "The head of support moves support rides. Operations rides are moved by an admin." });

  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock(7002, 0)");
    const ride = await db.query("SELECT id, ride_status FROM rides WHERE id = $1", [id]);
    if (!ride.rows[0]) { await db.query("ROLLBACK"); return res.status(404).json({ error: "Ride not found" }); }
    const ok = await db.query("SELECT staff_is_available($1, $2) AS ok", [userId, team]);
    if (!ok.rows[0].ok) { await db.query("ROLLBACK"); return res.status(409).json({ error: "That person isn't on duty for this team." }); }
    await db.query("INSERT INTO ride_team (ride_id) VALUES ($1) ON CONFLICT (ride_id) DO NOTHING", [id]);
    const col = team === "support" ? "support_user_id" : "operations_user_id";
    const cur = await db.query(`SELECT ${col} AS who FROM ride_team WHERE ride_id = $1 FOR UPDATE`, [id]);
    const from = cur.rows[0].who;
    if (from !== userId) {
      await db.query(`UPDATE ride_team SET ${col} = $2, updated_at = now() WHERE ride_id = $1`, [id, userId]);
      await db.query(
        `INSERT INTO ride_team_events (ride_id, team, kind, from_user_id, to_user_id, reason) VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, team, from ? "reassigned" : "assigned", from, userId, `moved by staff #${req.user.id}`]
      );
    }
    await db.query("COMMIT");
    res.json({ ok: true, changed: from !== userId });
  } catch (e) {
    try { await db.query("ROLLBACK"); } catch (_) {}
    console.error("Reassign failed:", e.message);
    res.status(503).json({ error: "Please try again." });
  } finally {
    db.release();
  }
});

// GET /api/staff/access-log  who has seen or used which number (head of support, admin)
router.get("/access-log", async (req, res) => {
  if (!(await svc.canManage(req.user))) return res.status(403).json({ error: "Only the head of support or an admin can read the access log." });
  const r = await pool.query(
    `SELECT a.id, a.action, a.subject_role, a.created_at, a.ride_id, s.name AS staff_name, s.role AS staff_role, subj.name AS subject_name
     FROM staff_contact_access a JOIN users s ON s.id = a.staff_user_id JOIN users subj ON subj.id = a.subject_user_id
     ORDER BY a.created_at DESC LIMIT 200`);
  res.json({ entries: r.rows.map((e) => ({ id: e.id, action: e.action, subjectRole: e.subject_role, at: e.created_at, rideId: e.ride_id, staff: e.staff_name, staffRole: e.staff_role, subject: e.subject_name })) });
});

// PUT /api/staff/lead/:userId  { isLead }  admin names the head of support
router.put("/lead/:userId", async (req, res) => {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Only an admin can name the head of support." });
  const uid = parseId(req.params.userId);
  if (!uid || typeof (req.body && req.body.isLead) !== "boolean") return res.status(400).json({ error: "Need a user and isLead true or false." });
  const u = await pool.query("SELECT id, role FROM users WHERE id = $1 AND deleted_at IS NULL", [uid]);
  if (!u.rows[0] || u.rows[0].role !== "support") return res.status(409).json({ error: "The head of support must be a support user." });
  await pool.query("UPDATE users SET support_lead = $2 WHERE id = $1", [uid, req.body.isLead]);
  res.json({ ok: true });
});

module.exports = router;
