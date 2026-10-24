// Every time staff see or dial a rider's or driver's full number, it goes in
// staff_contact_access (read on Ride Desk's "Number access" tab). Shared by Ride
// Desk (routes/staffRides.js) and the Trip Tracker (routes/admin.js).
const { pool } = require("../db/db");

// One row per person per ride per kind of access per 10 minutes, so
// refreshing a page does not bury the log, while a later look is still logged.
async function logAccess(staffId, rideId, subjectUserId, subjectRole, action) {
  await pool.query(
    `INSERT INTO staff_contact_access (staff_user_id, ride_id, subject_user_id, subject_role, action)
     SELECT $1, $2, $3, $4, $5
     WHERE NOT EXISTS (
       SELECT 1 FROM staff_contact_access
       WHERE staff_user_id = $1 AND ride_id = $2 AND subject_user_id = $3 AND action = $5
         AND created_at > now() - interval '10 minutes')`,
    [staffId, rideId, subjectUserId, subjectRole, action]
  );
}

// Calls are always logged; they are the thing worth counting.
async function logCall(staffId, rideId, subjectUserId, subjectRole) {
  await pool.query(
    `INSERT INTO staff_contact_access (staff_user_id, ride_id, subject_user_id, subject_role, action) VALUES ($1,$2,$3,$4,'call_from_phone')`,
    [staffId, rideId, subjectUserId, subjectRole]
  );
}

module.exports = { logAccess, logCall };
