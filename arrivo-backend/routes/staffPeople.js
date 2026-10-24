// Who is on the staff and who may change that. Rules live in services/staffAdmin.js.
//   GET  /api/staff/people              everyone on staff, with duty and load (admins and the head of support)
//   POST /api/staff/people/promote      { email, role }   bring an existing account onto the staff
//   PUT  /api/staff/people/:id/role     { role }          change role; "rider" removes from staff
//   PUT  /api/staff/people/:id/manage   { allowed }       owner only: let an admin manage staff
//   GET  /api/staff/people/events       who changed what, newest first
// A role change signs the person out everywhere, takes them off duty and hands
// their open rides to others straight away.
const express = require("express");
const { pool } = require("../db/db");
const { requireAuth, requireAnyRole } = require("../middleware/auth");
const rules = require("../services/staffAdmin");
const team = require("../services/rideTeam");
const access = require("../services/staffAccess");

const router = express.Router();
router.use(requireAuth, requireAnyRole(["admin", "support"]));

const parseId = (v) => { const n = Number(v); return Number.isInteger(n) && n >= 1 && n <= 2147483647 ? n : null; };

async function loadActor(req) {
  const r = await pool.query(
    "SELECT id, role, is_owner, can_manage_staff, support_lead FROM users WHERE id = $1 AND deleted_at IS NULL", [req.user.id]);
  return r.rows[0] || null;
}
// Admins and the head of support may look; only rules.canManagePeople may change.
async function requireViewer(req, res, next) {
  const a = await loadActor(req);
  if (!a || !(a.role === "admin" || (a.role === "support" && a.support_lead))) {
    return res.status(403).json({ error: "Only admins and the head of support can see the staff list." });
  }
  req.actor = a;
  next();
}
async function requireManager(req, res, next) {
  const a = req.actor || (await loadActor(req));
  if (!rules.canManagePeople(a)) return res.status(403).json({ error: "You do not have permission to manage staff." });
  req.actor = a;
  next();
}

router.get("/", requireViewer, async (req, res) => {
  const r = await pool.query(
    `SELECT u.id, u.name, u.email, u.role, u.is_owner, u.can_manage_staff, u.support_lead,
            u.staff_permissions, u.last_login_at, u.created_at,
            sd.on_duty, sd.team
       FROM users u LEFT JOIN staff_duty sd ON sd.user_id = u.id
      WHERE u.role IN ('admin','support','operations') AND u.deleted_at IS NULL
      ORDER BY u.is_owner DESC, (u.role = 'admin') DESC, u.role, u.name`);
  const people = [];
  for (const u of r.rows) {
    const load = sdLoad(u);
    people.push({
      ...u,
      openRides: load ? await load : 0,
      // What they can actually see and change, and which areas differ from their role.
      permissions: access.effectivePermissions(u),
      customised: Object.keys(access.cleanOverrides(u.staff_permissions)),
    });
  }
  res.json({
    me: { id: req.actor.id, isOwner: !!req.actor.is_owner, canManage: rules.canManagePeople(req.actor) },
    people,
  });
});
function sdLoad(u) {
  if (!u.team) return null;
  return pool.query("SELECT staff_open_load($1, $2) AS n", [u.id, u.team]).then((x) => x.rows[0].n);
}

async function applyRoleChange(client, actor, targetId, newRole, note) {
  const t = (await client.query(
    "SELECT id, role, is_owner FROM users WHERE id = $1 AND deleted_at IS NULL FOR UPDATE", [targetId])).rows[0];
  const owners = Number((await client.query("SELECT COUNT(*) AS n FROM users WHERE is_owner AND deleted_at IS NULL")).rows[0].n);
  const verdict = rules.checkRoleChange(actor, t, newRole, { ownersLeft: owners });
  if (!verdict.ok) return verdict;
  const from = t.role;
  await client.query(
    // A new role starts from that role's preset, so earlier per-area changes go.
    `UPDATE users SET role = $2, token_version = token_version + 1, staff_permissions = NULL,
            support_lead = CASE WHEN $2 = 'support' THEN support_lead ELSE false END,
            can_manage_staff = CASE WHEN $2 = 'admin' THEN can_manage_staff ELSE false END
      WHERE id = $1`, [targetId, newRole]);
  if (newRole === "rider") {
    await client.query("UPDATE staff_duty SET on_duty = false, updated_at = now() WHERE user_id = $1", [targetId]);
  } else {
    const teamName = team.defaultTeamFor(newRole);
    await client.query(
      `INSERT INTO staff_duty (user_id, team, on_duty) VALUES ($1, $2, false)
       ON CONFLICT (user_id) DO UPDATE SET team = $2, on_duty = false, updated_at = now()`, [targetId, teamName]);
  }
  await client.query(
    `INSERT INTO staff_role_events (actor_id, target_id, action, from_role, to_role, note)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [actor.id, targetId, newRole === "rider" ? "remove" : from === "rider" ? "promote" : "change", from, newRole, note || null]);
  return { ok: true, from };
}

async function runChange(req, res, targetId, newRole) {
  const note = typeof req.body?.note === "string" ? req.body.note.slice(0, 300) : null;
  const client = await pool.connect();
  let out;
  try {
    await client.query("BEGIN");
    out = await applyRoleChange(client, req.actor, targetId, newRole, note);
    await client.query(out.ok ? "COMMIT" : "ROLLBACK");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally { client.release(); }
  if (!out.ok) return res.status(out.status).json({ error: out.error, code: out.code });
  const moved = await team.rebalance("role_changed");
  res.json({ ok: true, from: out.from, to: newRole, ridesMoved: moved });
}

router.post("/promote", requireViewer, requireManager, async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const role = req.body?.role;
  if (!email || !rules.STAFF_ROLES.includes(role)) return res.status(400).json({ error: "Need an email and a role (admin, support or operations)." });
  const u = await pool.query("SELECT id FROM users WHERE lower(email) = $1 AND deleted_at IS NULL", [email]);
  if (!u.rows[0]) return res.status(404).json({ error: "No account with that email. They need to sign up first." });
  return runChange(req, res, u.rows[0].id, role);
});

router.put("/:id/role", requireViewer, requireManager, async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: "Bad id." });
  return runChange(req, res, id, req.body?.role);
});

router.put("/:id/manage", requireViewer, async (req, res) => {
  const id = parseId(req.params.id);
  if (!id || typeof req.body?.allowed !== "boolean") return res.status(400).json({ error: "Need a user and allowed true or false." });
  const t = (await pool.query("SELECT id, role FROM users WHERE id = $1 AND deleted_at IS NULL", [id])).rows[0];
  const v = rules.checkGrant(req.actor, t);
  if (!v.ok) return res.status(v.status).json({ error: v.error, code: v.code });
  await pool.query("UPDATE users SET can_manage_staff = $2 WHERE id = $1", [id, req.body.allowed]);
  await pool.query(
    "INSERT INTO staff_role_events (actor_id, target_id, action, from_role, to_role) VALUES ($1,$2,$3,'admin','admin')",
    [req.actor.id, id, req.body.allowed ? "grant_manage" : "revoke_manage"]);
  res.json({ ok: true });
});

// PUT /api/staff/people/:id/permissions  { permissions: { area: "none" | "view" | "manage" } }
// Areas left out keep their current level. Takes effect on their next request,
// no sign-out needed (middleware/auth.js reads it every time).
router.put("/:id/permissions", requireViewer, requireManager, async (req, res) => {
  const id = parseId(req.params.id);
  const wanted = req.body && req.body.permissions;
  if (!id || !wanted || typeof wanted !== "object" || Array.isArray(wanted)) {
    return res.status(400).json({ error: "Need a person and a permissions object." });
  }
  const bad = Object.entries(wanted).find(([area, level]) => !access.AREA_IDS.includes(area) || !access.LEVELS.includes(level));
  if (bad) return res.status(400).json({ error: `Unknown area or level: ${bad[0]} = ${bad[1]}` });

  const t = (await pool.query(
    "SELECT id, role, is_owner, staff_permissions FROM users WHERE id = $1 AND deleted_at IS NULL", [id])).rows[0];
  const verdict = rules.checkPermissionChange(req.actor, t);
  if (!verdict.ok) return res.status(verdict.status).json({ error: verdict.error, code: verdict.code });

  const before = access.effectivePermissions(t);
  const next = { ...before, ...wanted };
  const stored = access.diffFromPreset(t.role, next);
  await pool.query("UPDATE users SET staff_permissions = $2 WHERE id = $1",
    [id, Object.keys(stored).length ? JSON.stringify(stored) : null]);

  const changes = access.AREA_IDS.filter((a) => before[a] !== next[a]).map((a) => `${a}: ${before[a]} -> ${next[a]}`);
  if (changes.length) {
    await pool.query(
      `INSERT INTO staff_role_events (actor_id, target_id, action, from_role, to_role, note) VALUES ($1, $2, 'permissions', $3, $3, $4)`,
      [req.actor.id, id, t.role, changes.join(", ").slice(0, 300)]);
  }
  res.json({ ok: true, permissions: access.effectivePermissions({ ...t, staff_permissions: stored }), changed: changes });
});

router.get("/events", requireViewer, async (req, res) => {
  const r = await pool.query(
    `SELECT e.id, e.action, e.from_role, e.to_role, e.note, e.created_at,
            a.name AS actor_name, t.name AS target_name, t.email AS target_email
       FROM staff_role_events e
       LEFT JOIN users a ON a.id = e.actor_id LEFT JOIN users t ON t.id = e.target_id
      ORDER BY e.id DESC LIMIT 200`);
  res.json({ events: r.rows });
});

module.exports = router;
