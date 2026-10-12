// Names the owner. The owner is the one person who can make and remove admins
// and delegate staff management. This is a command line script on purpose: no
// API call, however privileged, can create an owner.
//   node scripts/set-owner.js owner@example.com          make this person the owner
//   node scripts/set-owner.js owner@example.com --remove take ownership away (refuses if they are the last owner)
require("dotenv").config();
const { pool, ready } = require("../db/db");

(async () => {
  const [, , email, flag] = process.argv;
  if (!email) { console.error("Usage: node scripts/set-owner.js email [--remove]"); process.exit(1); }
  await ready;
  const u = (await pool.query("SELECT id, role FROM users WHERE lower(email) = lower($1) AND deleted_at IS NULL", [email])).rows[0];
  if (!u) { console.error("No account with that email."); process.exit(1); }
  if (flag === "--remove") {
    const n = Number((await pool.query("SELECT COUNT(*) AS n FROM users WHERE is_owner AND deleted_at IS NULL")).rows[0].n);
    if (n <= 1) { console.error("That is the last owner. Name another first."); process.exit(1); }
    await pool.query("UPDATE users SET is_owner = false WHERE id = $1", [u.id]);
    console.log("Ownership removed.");
  } else {
    await pool.query("UPDATE users SET role = 'admin', is_owner = true, token_version = token_version + 1 WHERE id = $1", [u.id]);
    console.log("Done. They are now the owner and an admin. They must sign in again.");
  }
  await pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
