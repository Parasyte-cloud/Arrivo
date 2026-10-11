// Two-way complaints. A rider can report their driver and a driver can report
// their rider, about one ride. Rules:
//  - Who is accused is worked out from the ride, never taken from the client.
//  - The accused never sees the report.
//  - Only the rider or driver of that ride can file, once per category per ride,
//    from the moment the driver is assigned until 72 hours after the trip ends.
//  - About 10 a day per person. Description 10 to 1000 characters. Optional photo.
//  - Urgent categories get a 1 hour response target and an email alert, the rest 24 hours.
//  - 2 or more DIFFERENT riders filing urgent complaints against one driver in 14
//    days pauses that driver's Express automatically (a person reviews it next).
//    A rider is never auto-restricted; only flagged for an admin to decide.

const { validateImageDataUrl } = require("./imageValidation");
const { logSafetyEvent } = require("./safetyEvents");

const RIDER_CATEGORIES = ["unsafe_driving", "harassment", "felt_unsafe", "wrong_route", "overcharge", "vehicle_mismatch", "rude", "other"];
const DRIVER_CATEGORIES = ["harassment", "aggressive", "damage", "no_show", "unsafe_request", "intoxicated", "other"];
const URGENT = {
  rider: new Set(["unsafe_driving", "harassment", "felt_unsafe", "vehicle_mismatch"]),
  driver: new Set(["harassment", "aggressive", "unsafe_request", "intoxicated"]),
};
const ACTIONS = ["none", "warn", "pause_driver", "resume_driver", "require_selfie", "restrict_rider", "unrestrict_rider"];
const WINDOW_HOURS = 72;
const DAILY_LIMIT = 10;
const AUTO_PAUSE_RIDERS = 2;
const AUTO_PAUSE_DAYS = 14;
const MAX_PHOTO_BYTES = 3 * 1024 * 1024;

class ComplaintError extends Error {
  constructor(message, status = 400, code = "COMPLAINT_ERROR") {
    super(message);
    this.name = "ComplaintError";
    this.status = status;
    this.code = code;
  }
}

function getPool() {
  return require("../db/db").pool;
}

// ---- pure rules ----

function categoriesFor(role) {
  return role === "driver" ? DRIVER_CATEGORIES : RIDER_CATEGORIES;
}

function priorityFor(role, category) {
  return (URGENT[role] || new Set()).has(category) ? "urgent" : "normal";
}

function respondByFor(priority, now = new Date()) {
  return new Date(new Date(now).getTime() + (priority === "urgent" ? 1 : 24) * 3600 * 1000);
}

// Who is who on this ride. ride: { rider_id, driver_user_id }
function roleOnRide(ride, userId) {
  if (Number(ride.rider_id) === Number(userId)) return "rider";
  if (ride.driver_user_id != null && Number(ride.driver_user_id) === Number(userId)) return "driver";
  return null;
}

// Is the filing window open? ride: { ride_status, completed_at, updated_at, driver_user_id }
function windowOpen(ride, now = new Date()) {
  if (ride.driver_user_id == null) return false; // nobody to complain about yet
  if (["requested", "pending", "searching"].includes(ride.ride_status)) return false;
  if (["completed", "cancelled"].includes(ride.ride_status)) {
    const ended = new Date(ride.completed_at || ride.updated_at);
    return new Date(now).getTime() - ended.getTime() <= WINDOW_HOURS * 3600 * 1000;
  }
  return true; // accepted / in_progress
}

function cleanDescription(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

// ---- filing ----

async function loadRide(db, rideId) {
  const r = await db.query(
    `SELECT r.id, r.rider_id, r.driver_id, r.ride_status, r.completed_at, r.updated_at,
            d.user_id AS driver_user_id
       FROM rides r LEFT JOIN drivers d ON d.id = r.driver_id
      WHERE r.id = $1`,
    [rideId]
  );
  return r.rows[0] || null;
}

async function fileComplaint(userId, { rideId, category, description, photoDataUrl }, { db, now = new Date() } = {}) {
  const pool = db || getPool();
  const ride = await loadRide(pool, rideId);
  // 404 for both "no such ride" and "not your ride", so ride ids cannot be probed.
  const role = ride ? roleOnRide(ride, userId) : null;
  if (!role) throw new ComplaintError("Ride not found.", 404, "RIDE_NOT_FOUND");
  if (!categoriesFor(role).includes(category)) throw new ComplaintError("Pick one of the listed reasons.", 400, "BAD_CATEGORY");
  const text = cleanDescription(description);
  if (text.length < 10) throw new ComplaintError("Please tell us a little more (at least 10 characters).", 400, "DESCRIPTION_SHORT");
  if (text.length > 1000) throw new ComplaintError("Please keep it under 1000 characters.", 400, "DESCRIPTION_LONG");
  if (photoDataUrl) {
    const bad = validateImageDataUrl(photoDataUrl, "Photo", MAX_PHOTO_BYTES);
    if (bad) throw new ComplaintError(bad, 400, "PHOTO_INVALID");
  }
  if (!windowOpen(ride, now)) {
    throw new ComplaintError("Reports can be filed from when a driver is assigned until 72 hours after the trip ends.", 400, "WINDOW_CLOSED");
  }

  const today = await pool.query(
    "SELECT count(*)::int AS n FROM ride_complaints WHERE filed_by = $1 AND created_at > now() - interval '24 hours'",
    [userId]
  );
  if (today.rows[0].n >= DAILY_LIMIT) throw new ComplaintError("You have sent a lot of reports today. Please try again tomorrow.", 429, "TOO_MANY");

  const against = role === "rider" ? ride.driver_user_id : ride.rider_id;
  const priority = priorityFor(role, category);
  let row;
  try {
    const ins = await pool.query(
      `INSERT INTO ride_complaints (ride_id, filed_by, filer_role, against_user_id, category, priority, description, photo_data_url, respond_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, priority, respond_by, created_at`,
      [ride.id, userId, role, against, category, priority, text, photoDataUrl || null, respondByFor(priority, now)]
    );
    row = ins.rows[0];
  } catch (error) {
    if (error.code === "23505") throw new ComplaintError("You already reported this ride for that reason.", 409, "DUPLICATE");
    throw error;
  }

  await logSafetyEvent(pool, "complaint_filed", {
    rideId: ride.id, userId, driverId: ride.driver_id,
    detail: { complaintId: row.id, role, category, priority },
  });

  // The filer is never told whether this paused anyone.
  if (role === "rider" && priority === "urgent") await maybeAutoPauseDriver(pool, ride.driver_id, ride.id);
  if (priority === "urgent") notifyTeam(row.id, { role, category, rideId: ride.id }).catch(() => {});

  return { id: row.id, priority: row.priority, respondBy: row.respond_by };
}

// 2+ distinct riders with urgent complaints in 14 days pauses Express for that driver.
async function maybeAutoPauseDriver(db, driverId, rideId) {
  if (!driverId) return false;
  const r = await db.query(
    `SELECT count(DISTINCT c.filed_by)::int AS riders
       FROM ride_complaints c JOIN rides ri ON ri.id = c.ride_id
      WHERE ri.driver_id = $1 AND c.filer_role = 'rider' AND c.priority = 'urgent'
        AND c.created_at > now() - ($2 || ' days')::interval`,
    [driverId, String(AUTO_PAUSE_DAYS)]
  );
  if (r.rows[0].riders < AUTO_PAUSE_RIDERS) return false;
  const upd = await db.query(
    `UPDATE drivers SET accepts_instant = false, express_paused_at = now(),
            express_paused_reason = 'Automatic: urgent reports from ' || $2::text || ' different riders in ' || $3::text || ' days'
      WHERE id = $1 AND express_paused_at IS NULL RETURNING id`,
    [driverId, String(r.rows[0].riders), String(AUTO_PAUSE_DAYS)]
  );
  if (upd.rowCount) {
    await logSafetyEvent(db, "driver_auto_paused", { rideId, driverId, detail: { riders: r.rows[0].riders, days: AUTO_PAUSE_DAYS } });
    return true;
  }
  return false;
}

async function notifyTeam(complaintId, info) {
  const to = process.env.SAFETY_ALERT_EMAIL;
  if (!to) return;
  const { sendEmail, escapeHtml } = require("./email");
  await sendEmail({
    to,
    subject: `URGENT safety report #${complaintId} (${info.category})`,
    html: `<p>A ${escapeHtml(info.role)} filed an urgent report on ride ${escapeHtml(info.rideId)} (${escapeHtml(info.category)}). Response target: 1 hour.</p><p>Open the Safety page in the admin app.</p>`,
  });
}

// ---- reading ----

// A filer sees only their own reports: never anything about who else reported.
async function listMine(userId, { db } = {}) {
  const r = await (db || getPool()).query(
    `SELECT id, ride_id, category, status, created_at,
            CASE WHEN status IN ('resolved','dismissed') THEN resolution END AS resolution
       FROM ride_complaints WHERE filed_by = $1 ORDER BY created_at DESC LIMIT 50`,
    [userId]
  );
  return r.rows;
}

async function listForAdmin({ status, priority, db, limit = 100 } = {}) {
  const where = [];
  const params = [];
  if (["open", "investigating", "resolved", "dismissed"].includes(status)) { params.push(status); where.push(`c.status = $${params.length}`); }
  if (["urgent", "normal"].includes(priority)) { params.push(priority); where.push(`c.priority = $${params.length}`); }
  params.push(Math.min(Math.max(Number(limit) || 100, 1), 300));
  const r = await (db || getPool()).query(
    `SELECT c.id, c.ride_id, c.filer_role, c.category, c.priority, c.description, c.photo_data_url,
            c.status, c.resolution, c.action, c.respond_by, c.created_at, c.resolved_at,
            c.respond_by < now() AND c.status IN ('open','investigating') AS overdue,
            fu.name AS filer_name, au.name AS against_name, c.against_user_id, c.filed_by,
            (SELECT count(*)::int FROM ride_complaints x WHERE x.against_user_id = c.against_user_id AND x.id <> c.id) AS other_reports_against
       FROM ride_complaints c
       JOIN users fu ON fu.id = c.filed_by
       JOIN users au ON au.id = c.against_user_id
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY (c.status IN ('open','investigating')) DESC, (c.priority = 'urgent') DESC, c.respond_by ASC
      LIMIT $${params.length}`,
    params
  );
  return r.rows;
}

// ---- resolving ----

async function resolve(complaintId, adminUserId, { status, resolution = "", action = "none" }, { db } = {}) {
  const pool = db || getPool();
  if (!["investigating", "resolved", "dismissed"].includes(status)) throw new ComplaintError("Status must be investigating, resolved or dismissed.", 400, "BAD_STATUS");
  if (!ACTIONS.includes(action)) throw new ComplaintError("Unknown action.", 400, "BAD_ACTION");
  const note = String(resolution || "").trim();
  if (status !== "investigating" && note.length < 5) throw new ComplaintError("Write a short outcome note (at least 5 characters).", 400, "NOTE_REQUIRED");

  const client = pool.connect ? await pool.connect() : pool;
  try {
    await client.query("BEGIN");
    const c = await client.query(
      `SELECT c.*, ri.driver_id FROM ride_complaints c JOIN rides ri ON ri.id = c.ride_id WHERE c.id = $1 FOR UPDATE OF c`,
      [complaintId]
    );
    if (!c.rowCount) { await client.query("ROLLBACK"); throw new ComplaintError("Report not found.", 404, "NOT_FOUND"); }
    const row = c.rows[0];
    if (["resolved", "dismissed"].includes(row.status)) { await client.query("ROLLBACK"); throw new ComplaintError("That report is already closed.", 409, "ALREADY_CLOSED"); }

    // Actions must match who was accused.
    const accusedIsDriver = row.filer_role === "rider";
    const driverActions = ["pause_driver", "resume_driver", "require_selfie"];
    const riderActions = ["restrict_rider", "unrestrict_rider"];
    if ((driverActions.includes(action) && !accusedIsDriver) || (riderActions.includes(action) && accusedIsDriver)) {
      await client.query("ROLLBACK");
      throw new ComplaintError("That action does not apply to the person this report is about.", 400, "ACTION_MISMATCH");
    }

    if (action === "pause_driver") {
      await client.query("UPDATE drivers SET accepts_instant = false, express_paused_at = now(), express_paused_reason = $2 WHERE id = $1", [row.driver_id, `Admin: report #${row.id}`]);
    } else if (action === "resume_driver") {
      await client.query("UPDATE drivers SET express_paused_at = NULL, express_paused_reason = NULL WHERE id = $1", [row.driver_id]);
    } else if (action === "require_selfie") {
      await client.query("UPDATE drivers SET selfie_recheck_required = true, is_online = false WHERE id = $1", [row.driver_id]);
    } else if (action === "restrict_rider") {
      await client.query("UPDATE users SET express_restricted_at = now(), express_restricted_reason = $2 WHERE id = $1", [row.against_user_id, `Report #${row.id}: ${note}`.slice(0, 300)]);
    } else if (action === "unrestrict_rider") {
      await client.query("UPDATE users SET express_restricted_at = NULL, express_restricted_reason = NULL WHERE id = $1", [row.against_user_id]);
    }

    const closing = status !== "investigating";
    await client.query(
      `UPDATE ride_complaints SET status = $2, resolution = COALESCE(NULLIF($3, ''), resolution), action = $4,
              resolved_by = CASE WHEN $5 THEN $6::int ELSE resolved_by END,
              resolved_at = CASE WHEN $5 THEN now() ELSE resolved_at END, updated_at = now()
        WHERE id = $1`,
      [row.id, status, note, action, closing, adminUserId]
    );
    await logSafetyEvent(client, "complaint_" + status, {
      rideId: row.ride_id, userId: adminUserId, driverId: row.driver_id,
      detail: { complaintId: row.id, action, note },
    });
    await client.query("COMMIT");

    if (closing) notifyFiler(pool, row.filed_by, status).catch(() => {});
    return { id: row.id, status, action };
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch (_) { /* already rolled back */ }
    throw error;
  } finally {
    if (client.release) client.release();
  }
}

async function notifyFiler(db, userId, status) {
  const u = await db.query("SELECT push_token FROM users WHERE id = $1", [userId]);
  const token = u.rows[0]?.push_token;
  if (!token) return;
  const { sendPushNotification } = require("./pushNotifications");
  await sendPushNotification(
    token,
    "Your report was reviewed",
    status === "dismissed" ? "We looked into your report. Open the app for the outcome." : "We acted on your report. Open the app for the outcome.",
    { type: "complaint_update" }
  );
}

module.exports = {
  ComplaintError, RIDER_CATEGORIES, DRIVER_CATEGORIES, ACTIONS, WINDOW_HOURS, DAILY_LIMIT,
  categoriesFor, priorityFor, respondByFor, roleOnRide, windowOpen, cleanDescription,
  fileComplaint, listMine, listForAdmin, resolve, maybeAutoPauseDriver,
};
