// Creates an ArrivoOps Operations account directly in PostgreSQL.
//
// This is intentionally NOT an API endpoint. Operations accounts must never
// be publicly self-provisioned.
//
// The role is hard-coded to "operations". This script cannot create an admin
// or support account.
//
// Password input comes from OPERATIONS_PASSWORD rather than a command-line
// argument so the password does not need to appear in shell history.
//
// Usage:
//   OPERATIONS_PASSWORD="..." node scripts/create-operations.js \
//     "Full Name" "operations@ridearrivo.com"

require("dotenv").config();

const bcrypt = require("bcryptjs");
const { Pool } = require("pg");

const [, , rawName, rawEmail] = process.argv;

const name = String(rawName || "").trim();
const email = String(rawEmail || "").trim().toLowerCase();
const password = process.env.OPERATIONS_PASSWORD || "";

if (!name || !email) {
  console.error(
    'Usage: OPERATIONS_PASSWORD="..." node scripts/create-operations.js "Full Name" "email@example.com"'
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
    "OPERATIONS_PASSWORD must be at least 16 characters."
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

    console.error("OPERATIONS_ACCOUNT_CREATED=NO");
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
      VALUES ($1, $2, $3, 'operations')
      RETURNING id, name, email, role
    `,
    [name, email, passwordHash]
  );

  const user = result.rows[0];

  if (!user) {
    throw new Error("Insert returned no user.");
  }

  if (user.role !== "operations") {
    throw new Error(
      `Unexpected role returned after insert: ${user.role}`
    );
  }

  if (user.email !== email) {
    throw new Error(
      "Created email does not match requested email."
    );
  }

  console.log("OPERATIONS_ACCOUNT_CREATED=YES");
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
      "OPERATIONS_ACCOUNT_CREATION_FAILED:",
      err.message
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
