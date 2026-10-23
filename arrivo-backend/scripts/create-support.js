// Creates an ArrivoOps Support account directly in PostgreSQL.
//
// This is intentionally NOT an API endpoint. Support accounts must never
// be publicly self-provisioned.
//
// The role is hard-coded to "support". This script cannot create an admin
// or operations account. Support is read only in the console and the backend:
// every change is refused server-side by requireRole("admin").
//
// Password input comes from SUPPORT_PASSWORD rather than a command-line
// argument so the password does not need to appear in shell history.
//
// Usage:
//   SUPPORT_PASSWORD="..." node scripts/create-support.js \
//     "Full Name" "support@ridearrivo.com"

require("dotenv").config();

const bcrypt = require("bcryptjs");
const { Pool } = require("pg");

const [, , rawName, rawEmail] = process.argv;

const name = String(rawName || "").trim();
const email = String(rawEmail || "").trim().toLowerCase();
const password = process.env.SUPPORT_PASSWORD || "";

if (!name || !email) {
  console.error(
    'Usage: SUPPORT_PASSWORD="..." node scripts/create-support.js "Full Name" "email@example.com"'
  );
  process.exit(1);
}

if (
  !email.includes("@")
  || email.startsWith("@")
  || email.endsWith("@")
  || /\s/.test(email)
) {
  console.error("Invalid email address.");
  process.exit(1);
}

if (password.length < 16) {
  console.error(
    "SUPPORT_PASSWORD must be at least 16 characters."
  );
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not configured.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("localhost")
    ? false
    : { rejectUnauthorized: false },
});

async function main() {
  const existing = await pool.query(
    `
      SELECT id, name, email, role
      FROM users
      WHERE lower(email) = lower($1)
      LIMIT 1
    `,
    [email]
  );

  if (existing.rows[0]) {
    const user = existing.rows[0];

    console.error("SUPPORT_ACCOUNT_CREATED=NO");
    console.error("REASON=EMAIL_ALREADY_EXISTS");
    console.error(`USER_ID=${user.id}`);
    console.error(`EMAIL=${user.email}`);
    console.error(`EXISTING_ROLE=${user.role}`);

    process.exitCode = 2;
    return;
  }

  const passwordHash = bcrypt.hashSync(password, 12);

  const result = await pool.query(
    `
      INSERT INTO users (
        name,
        email,
        password_hash,
        role
      )
      VALUES ($1, $2, $3, 'support')
      RETURNING id, name, email, role
    `,
    [name, email, passwordHash]
  );

  const user = result.rows[0];

  if (!user) {
    throw new Error("Insert returned no user.");
  }

  if (user.role !== "support") {
    throw new Error(
      `Unexpected role returned after insert: ${user.role}`
    );
  }

  if (user.email !== email) {
    throw new Error(
      "Created email does not match requested email."
    );
  }

  console.log("SUPPORT_ACCOUNT_CREATED=YES");
  console.log(`USER_ID=${user.id}`);
  console.log(`NAME=${user.name}`);
  console.log(`EMAIL=${user.email}`);
  console.log(`ROLE=${user.role}`);
  console.log("ACCESS=READ_ONLY");
  console.log("PASSWORD_HASH_PRINTED=NO");
}

main()
  .catch((err) => {
    console.error(
      "SUPPORT_ACCOUNT_CREATION_FAILED:",
      err.message
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
