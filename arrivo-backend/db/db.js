const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is not set. Copy .env.example to .env and set it to your Postgres connection string " +
    "(a free one from neon.tech or supabase.com works fine — see README.md)."
  );
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Most free hosted Postgres providers (Neon, Supabase, Render) require SSL,
  // but issue certs that Node's default strict verification will reject.
  // rejectUnauthorized: false is the standard, accepted way to handle this
  // for these providers — the connection is still encrypted, just not
  // verified against a CA bundle.
  ssl: process.env.DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false },
});

// Run the schema on startup — every statement uses IF NOT EXISTS, so this
// is safe to re-run and just no-ops on an already-initialized database.
const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
const ready = pool.query(schema).catch((err) => {
  console.error("Failed to initialize database schema:", err.message);
  process.exit(1);
});

module.exports = { pool, ready };
