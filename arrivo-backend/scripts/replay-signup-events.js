// Re-sends signup events the Notification Platform may have missed (backend restarted mid-send, platform down).
// Safe to run any number of times: event keys are stable, so a customer never gets a second journey.
//
//   node scripts/replay-signup-events.js --hours 48            # dry run, prints how many would be sent
//   node scripts/replay-signup-events.js --hours 48 --send     # sends them
//
// Only accounts created in the window are considered, and deleted accounts are skipped.
require("dotenv").config();
const { pool, ready } = require("../db/db");
const notifyPlatform = require("../services/notifyPlatform");

async function main() {
  const args = process.argv.slice(2);
  const hours = Number(args[args.indexOf("--hours") + 1]) || 48;
  const send = args.includes("--send");
  if (hours <= 0 || hours > 24 * 30) throw new Error("--hours must be between 1 and 720");
  if (send && !notifyPlatform.config().ready) throw new Error("NOTIFY_INGEST_URL (https) and NOTIFY_INGEST_SECRET (32+ characters) must be set.");
  if (ready) await ready;
  const { rows } = await pool.query(
    `SELECT id, name, email, email_verified, created_at, preferred_language, country_of_residence
       FROM users WHERE created_at > now() - ($1 || ' hours')::interval AND deleted_at IS NULL AND role = 'rider' ORDER BY created_at`,
    [String(hours)]
  );
  console.log(`${rows.length} rider account(s) created in the last ${hours} hours.`);
  if (!send) return console.log("Dry run. Add --send to send them.");
  let ok = 0;
  for (const u of rows) {
    const r = await notifyPlatform.emitSignup(u);
    if (r.sent) ok++;
  }
  console.log(`Sent ${ok} of ${rows.length}.`);
}

main().then(() => pool.end(), (e) => { console.error(e.message); pool.end().finally(() => process.exit(1)); });
