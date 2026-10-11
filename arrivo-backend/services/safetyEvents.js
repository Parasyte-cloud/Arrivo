// One place to write the safety audit trail. Never throws: an audit write
// failing must not undo or block the safety action itself.
async function logSafetyEvent(db, kind, { rideId = null, userId = null, driverId = null, detail = {} } = {}) {
  try {
    await (db || require("../db/db").pool).query(
      "INSERT INTO safety_events (kind, ride_id, user_id, driver_id, detail) VALUES ($1, $2, $3, $4, $5::jsonb)",
      [kind, rideId, userId, driverId, JSON.stringify(detail)]
    );
  } catch (error) {
    console.error(`Safety event '${kind}' could not be logged:`, error.message);
  }
}
module.exports = { logSafetyEvent };
