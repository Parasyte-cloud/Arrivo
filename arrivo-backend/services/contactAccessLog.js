// Every time staff see or dial a rider's or driver's full number, it goes in
// staff_contact_access (read on Ride Desk's "Number access" tab). Shared by Ride
// Desk (routes/staffRides.js) and the Trip Tracker (routes/admin.js).
const { pool } = require("../db/db");

// Every disclosure is a security/privacy event. Do not deduplicate these
// records: repeated reveals must remain independently auditable.
async function logAccess(staffId, rideId, subjectUserId, subjectRole, action) {
  await pool.query(
    `INSERT INTO staff_contact_access
       (staff_user_id, ride_id, subject_user_id, subject_role, action)
     VALUES ($1, $2, $3, $4, $5)`,
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
