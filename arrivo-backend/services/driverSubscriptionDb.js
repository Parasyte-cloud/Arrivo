// Database side of the driver subscription: one place that answers
// "has this driver paid for today?" so every gate asks the same question.
const { pool } = require("../db/db");

// OFF by default, so deploying this cannot stop drivers on old app builds from
// getting orders. Set DRIVER_SUBSCRIPTION_ENFORCED=true once the new driver
// build is out and drivers can pay from it.
function isEnforced() {
  return String(process.env.DRIVER_SUBSCRIPTION_ENFORCED || "false").toLowerCase() === "true";
}

// The Lagos day, worked out by the database so it cannot drift from the clock
// that wrote the rows.
const TODAY_SQL = "(now() AT TIME ZONE 'Africa/Lagos')::date";

async function hasActiveSubscription(db, driverId) {
  if (!isEnforced()) return true;
  const r = await (db || pool).query(
    `SELECT 1 FROM driver_subscription_days WHERE driver_id = $1 AND day = ${TODAY_SQL}`,
    [driverId]
  );
  return r.rows.length > 0;
}

const SUBSCRIPTION_REQUIRED = {
  code: "SUBSCRIPTION_REQUIRED",
  error: "Subscribe for today (₦2,000) to receive orders. Your subscription ends at 12am.",
};

module.exports = { isEnforced, hasActiveSubscription, TODAY_SQL, SUBSCRIPTION_REQUIRED };
