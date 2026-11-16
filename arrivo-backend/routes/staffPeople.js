// Who is on the staff and who may change that. Rules live in services/staffAdmin.js.
//   GET  /api/staff/people              everyone on staff, with duty and load (admins and the head of support)
//   POST /api/staff/people/promote      { email, role }   bring an existing account onto the staff
//   PUT  /api/staff/people/:id/role     { role }          change role; "rider" removes from staff
//   PUT  /api/staff/people/:id/manage   { allowed }       owner only: let an admin manage staff
//   GET  /api/staff/people/events       who changed what, newest first
// A role change signs the person out everywhere, takes them off duty and hands
// their open rides to others straight away.
const express = require("express");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { pool } = require("../db/db");
const { requireAuth, requireAnyRole } = require("../middleware/auth");
const rules = require("../services/staffAdmin");
const team = require("../services/rideTeam");
const access = require("../services/staffAccess");
const { sendPasswordResetEmail } = require("../services/email");
const { issueResetToken } = require("../services/passwordResetToken");

const SALT_ROUNDS = 10;
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
            u.staff_invited_at,
            u.staff_invite_expires_at,
            u.staff_activated_at,
            u.staff_invite_delivery_status,
            u.staff_invite_last_attempt_at,
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
      setup_status:
        !u.staff_invited_at || u.staff_activated_at
          ? "active"
          : u.staff_invite_expires_at &&
              new Date(u.staff_invite_expires_at).getTime() > Date.now()
            ? "pending"
            : "expired",
      invitation_delivery_status:
        u.staff_invite_delivery_status || null,
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

function passwordSetupUrl(token) {
  return `${
    process.env.PASSWORD_RESET_BASE_URL ||
    "https://ridearrivo.com/reset-password.html"
  }?token=${token}`;
}

async function deliverStaffSetupEmail(email, token) {
  try {
    const result = await sendPasswordResetEmail(
      email,
      passwordSetupUrl(token)
    );

    if (result?.ok) return "sent";
    if (result?.skipped) return "not_configured";

    return "failed";
  } catch (error) {
    console.error(
      "Staff password setup email failed:",
      error?.message || error
    );

    return "failed";
  }
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
const email =
String(req.body?.email || "")
.trim()
.toLowerCase();

const role = req.body?.role;

if (
!email ||
!rules.STAFF_ROLES.includes(role)
) {
return res.status(400).json({
error:
"Need an email and a role (admin, support or operations).",
});
}

/*
 * Existing Arrivo account:
 * preserve the current governed role-change path.
 */
const existing = await pool.query(
`SELECT id
FROM users
WHERE lower(email) = $1
AND deleted_at IS NULL`,
[email]
);

if (existing.rows[0]) {
return runChange(
req,
res,
existing.rows[0].id,
role
);
}

/*
 * Never auto-provision an external identity.
 * New staff provisioning is restricted to RideArrivo company mail.
 */
if (!email.endsWith("@ridearrivo.com")) {
return res.status(404).json({
error:
"No RideArrivo account exists with that email.",
});
}

const requestedName =
String(req.body?.name || "")
.trim();

const inferredName =
email
.split("@")[0]
.replace(/[._-]+/g, " ")
.replace(
/\b\w/g,
(char) => char.toUpperCase()
)
.trim() ||
"RideArrivo staff";

const displayName =
(requestedName || inferredName)
.slice(0, 120);

const randomPassword =
crypto
.randomBytes(32)
.toString("hex");

const passwordHash =
bcrypt.hashSync(
randomPassword,
SALT_ROUNDS
);

const {
token: resetToken,
storedToken,
} = issueResetToken();

const resetExpires =
new Date(
Date.now() +
60 * 60 * 1000
);

const client =
await pool.connect();

let createdId = null;
let roleChange = null;

try {
await client.query("BEGIN");

/*
 * Start as rider only so the normal staff-governance function remains
 * authoritative for the actual promotion.
 */
const inserted =
await client.query(
`INSERT INTO users (
name,
email,
password_hash,
role,
reset_token,
reset_token_expires,
staff_invited_at,
staff_invited_by,
staff_invite_expires_at
)
VALUES (
$1,
$2,
$3,
'rider',
$4,
$5,
now(),
$6,
$5
)
RETURNING id`,
[
displayName,
email,
passwordHash,
storedToken,
resetExpires,
req.actor.id,
]
);

createdId =
inserted.rows[0].id;

roleChange =
await applyRoleChange(
client,
req.actor,
createdId,
role,
"Provisioned from Team & Access"
);

if (!roleChange.ok) {
await client.query("ROLLBACK");

return res
.status(roleChange.status)
.json({
error: roleChange.error,
code: roleChange.code,
});
}

await client.query("COMMIT");
} catch (error) {
await client
.query("ROLLBACK")
.catch(() => {});

if (error?.code === "23505") {
return res.status(409).json({
error:
"That staff account was created at the same time. Refresh Team & Access and try again.",
});
}

throw error;
} finally {
client.release();
}

const moved =
await team.rebalance(
"role_changed"
);

const emailDelivery =
await deliverStaffSetupEmail(
email,
resetToken
);

await pool.query(
`UPDATE users
    SET staff_invite_delivery_status = $2,
        staff_invite_last_attempt_at = now()
  WHERE id = $1`,
[createdId, emailDelivery]
);

return res.json({
ok: true,
created: true,
from: roleChange.from,
to: role,
ridesMoved: moved,
setupRequired: true,
setupStatus: "pending",
emailDelivery,
});
});

router.post(
"/:id/resend-setup",
requireViewer,
requireManager,
async (req, res) => {
  const id = parseId(req.params.id);

  if (!id) {
    return res.status(400).json({
      error: "Bad id.",
    });
  }

  const target = (
    await pool.query(
      `SELECT
         id,
         email,
         role,
         is_owner,
         staff_invited_at,
         staff_activated_at
       FROM users
       WHERE id = $1
         AND deleted_at IS NULL`,
      [id]
    )
  ).rows[0];

  if (!target) {
    return res.status(404).json({
      error: "Staff account not found.",
    });
  }

  /*
   * Delegated staff managers may manage Support/Operations,
   * but only the owner may manage an Admin invitation.
   */
  if (
    target.role === "admin" &&
    !req.actor.is_owner
  ) {
    return res.status(403).json({
      error:
        "Only the owner can manage an administrator setup invitation.",
    });
  }

  if (
    !rules.STAFF_ROLES.includes(target.role) ||
    !target.staff_invited_at ||
    target.staff_activated_at
  ) {
    return res.status(409).json({
      error:
        "This account does not have a pending staff setup invitation.",
    });
  }

  const email =
    String(target.email || "")
      .trim()
      .toLowerCase();

  if (!email.endsWith("@ridearrivo.com")) {
    return res.status(409).json({
      error:
        "Staff setup invitations can only be sent to RideArrivo company email addresses.",
    });
  }

  const {
    token: resetToken,
    storedToken,
  } = issueResetToken();

  const resetExpires =
    new Date(
      Date.now() +
      60 * 60 * 1000
    );

  await pool.query(
    `UPDATE users
        SET reset_token = $2,
            reset_token_expires = $3,
            staff_invited_by = $4,
            staff_invite_expires_at = $3,
            staff_invite_delivery_status = NULL
      WHERE id = $1`,
    [
      id,
      storedToken,
      resetExpires,
      req.actor.id,
    ]
  );

  const emailDelivery =
    await deliverStaffSetupEmail(
      email,
      resetToken
    );

  await pool.query(
    `UPDATE users
        SET staff_invite_delivery_status = $2,
            staff_invite_last_attempt_at = now()
      WHERE id = $1`,
    [id, emailDelivery]
  );

  await pool.query(
    `INSERT INTO staff_role_events (
       actor_id,
       target_id,
       action,
       from_role,
       to_role,
       note
     )
     VALUES (
       $1,
       $2,
       'setup_email',
       $3,
       $3,
       $4
     )`,
    [
      req.actor.id,
      id,
      target.role,
      `delivery=${emailDelivery}`,
    ]
  );

  return res.json({
    ok: true,
    setupRequired: true,
    setupStatus: "pending",
    emailDelivery,
  });
}
);

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
