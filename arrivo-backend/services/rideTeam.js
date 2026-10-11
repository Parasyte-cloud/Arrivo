// Ride teams: duty, assignment sweeps, and the lookups the staff Rides section uses.
// The assignment itself lives in Postgres (db/schema.sql: assign_ride_team,
// rebalance_ride_teams) so it is atomic and covers every way a ride is created.
const { pool } = require("../db/db");

const STAFF_ROLES = ["admin", "support", "operations"];
const SWEEP_EVERY_MS = 30 * 1000;

const firstName = (name) => String(name || "").trim().split(/\s+/)[0] || null;

// Last three digits only, enough for staff to recognise a number in a list
// without a list of full numbers sitting on screen.
function phoneHint(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  return digits.length >= 4 ? `••• ${digits.slice(-3)}` : null;
}

async function isLead(userId) {
  const r = await pool.query("SELECT support_lead FROM users WHERE id = $1 AND deleted_at IS NULL", [userId]);
  return !!(r.rows[0] && r.rows[0].support_lead);
}

// admin, or the head of support
async function canManage(user) {
  if (!user) return false;
  if (user.role === "admin") return true;
  return user.role === "support" && (await isLead(user.id));
}

function defaultTeamFor(role) {
  return role === "operations" ? "operations" : "support";
}

async function getDuty(userId) {
  const r = await pool.query("SELECT user_id, team, on_duty, max_open FROM staff_duty WHERE user_id = $1", [userId]);
  const row = r.rows[0];
  if (!row) return null;
  const load = await pool.query("SELECT staff_open_load($1, $2) AS n", [userId, row.team]);
  return { userId: row.user_id, team: row.team, onDuty: row.on_duty, maxOpen: row.max_open, openRides: load.rows[0].n };
}

// Puts someone on or off duty, then lets the balancer react straight away:
// going on duty picks up queued rides, going off hands theirs to others.
async function setDuty({ userId, role, onDuty, team, maxOpen }) {
  const t = team || defaultTeamFor(role);
  if (!["support", "operations"].includes(t)) throw Object.assign(new Error("team must be support or operations"), { status: 400 });
  if (role !== "admin" && t !== defaultTeamFor(role)) throw Object.assign(new Error("That team doesn't match this person's role."), { status: 403 });
  await pool.query(
    `INSERT INTO staff_duty (user_id, team, on_duty, max_open) VALUES ($1, $2, $3, COALESCE($4, 25))
     ON CONFLICT (user_id) DO UPDATE SET team = EXCLUDED.team, on_duty = EXCLUDED.on_duty,
       max_open = COALESCE($4, staff_duty.max_open), updated_at = now()`,
    [userId, t, !!onDuty, maxOpen == null ? null : Math.max(1, Math.min(500, Number(maxOpen) || 25))]
  );
  const moved = await rebalance(onDuty ? "went_on_duty" : "went_off_duty");
  return { duty: await getDuty(userId), moved };
}

async function rebalance(reason = "sweep") {
  const r = await pool.query("SELECT rebalance_ride_teams($1) AS n", [reason]);
  return r.rows[0].n;
}

let sweepTimer = null;
function startRideTeamSweep() {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    rebalance("sweep").catch((e) => console.error("Ride team sweep failed:", e.message));
  }, SWEEP_EVERY_MS);
  if (sweepTimer.unref) sweepTimer.unref();
}

module.exports = { STAFF_ROLES, firstName, phoneHint, isLead, canManage, defaultTeamFor, getDuty, setDuty, rebalance, startRideTeamSweep };
