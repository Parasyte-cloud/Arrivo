// Resets a user's password directly in the database. This is a stopgap —
// there's no "forgot password" email flow yet (see README), so this script
// is how you (the operator) can reset someone's password by hand until
// that's built.
//
// Usage:
//   node scripts/reset-password.js "email@example.com" "a-new-strong-password"

require("dotenv").config();
const bcrypt = require("bcryptjs");
const { pool, ready } = require("../db/db");

const [, , email, newPassword] = process.argv;

if (!email || !newPassword) {
  console.error("Usage: node scripts/reset-password.js \"email@example.com\" \"new-password\"");
  process.exit(1);
}
if (newPassword.length < 6) {
  console.error("Password must be at least 6 characters.");
  process.exit(1);
}

async function main() {
  await ready;

  const existing = await pool.query("SELECT id, name, role FROM users WHERE email = $1", [email.toLowerCase()]);
  const user = existing.rows[0];
  if (!user) {
    console.error(`No user found with email ${email}.`);
    process.exit(1);
  }

  const passwordHash = bcrypt.hashSync(newPassword, 10);
  await pool.query("UPDATE users SET password_hash = $1 WHERE id = $2", [passwordHash, user.id]);

  console.log(`✅ Password reset for ${user.name} <${email}> (role: ${user.role}).`);
  console.log("They can now log in with the new password.");
  await pool.end();
}

main().catch((err) => {
  console.error("Failed to reset password:", err.message);
  process.exit(1);
});
