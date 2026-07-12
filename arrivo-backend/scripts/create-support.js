// Creates a read-only support account directly in the database.
// Like create-admin.js, this is intentionally NOT an API endpoint — support
// accounts should never be creatable over the network by anyone who can
// reach your API. A support account can log in to the same admin
// dashboard as a real admin, but every mutating action there (verifying a
// driver, resolving a panic, editing a ride) is rejected server-side by
// requireRole("admin") in routes/admin.js — the frontend hiding those
// buttons is just UX, this script's role field is what actually enforces it.
//
// Usage:
//   node scripts/create-support.js "Full Name" "email@example.com" "a-strong-password"

require("dotenv").config();
const bcrypt = require("bcryptjs");
const { pool, ready } = require("../db/db");

const [, , name, email, password] = process.argv;

if (!name || !email || !password) {
  console.error("Usage: node scripts/create-support.js \"Full Name\" \"email@example.com\" \"password\"");
  process.exit(1);
}
if (password.length < 6) {
  console.error("Password must be at least 6 characters.");
  process.exit(1);
}

async function main() {
  await ready;

  const existing = await pool.query("SELECT id FROM users WHERE email = $1", [email.toLowerCase()]);
  if (existing.rows[0]) {
    console.error(`A user with email ${email} already exists (id ${existing.rows[0].id}).`);
    console.error("If you meant to give them read-only access, update their role manually in the database instead.");
    process.exit(1);
  }

  const passwordHash = bcrypt.hashSync(password, 10);
  const result = await pool.query(
    `INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, 'support') RETURNING id`,
    [name, email.toLowerCase(), passwordHash]
  );

  console.log(`✅ Support account created: ${name} <${email}> (user id ${result.rows[0].id})`);
  console.log("They can log in to the admin dashboard with this email and password.");
  console.log("They'll see everything but won't be able to verify drivers, resolve panics, or edit rides.");
  await pool.end();
}

main().catch((err) => {
  console.error("Failed to create support account:", err.message);
  process.exit(1);
});
