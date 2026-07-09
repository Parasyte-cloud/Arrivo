// Creates an admin account directly in the database.
// This is intentionally NOT an API endpoint — admin accounts should never
// be creatable over the network by anyone who can reach your API.
//
// Usage:
//   node scripts/create-admin.js "Full Name" "email@example.com" "a-strong-password"

require("dotenv").config();
const bcrypt = require("bcryptjs");
const { pool, ready } = require("../db/db");

const [, , name, email, password] = process.argv;

if (!name || !email || !password) {
  console.error("Usage: node scripts/create-admin.js \"Full Name\" \"email@example.com\" \"password\"");
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
    console.error("If you meant to promote them to admin, update their role manually in the database.");
    process.exit(1);
  }

  const passwordHash = bcrypt.hashSync(password, 10);
  const result = await pool.query(
    `INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, 'admin') RETURNING id`,
    [name, email.toLowerCase(), passwordHash]
  );

  console.log(`✅ Admin account created: ${name} <${email}> (user id ${result.rows[0].id})`);
  console.log("They can now log in to the admin dashboard with this email and password.");
  await pool.end();
}

main().catch((err) => {
  console.error("Failed to create admin:", err.message);
  process.exit(1);
});
