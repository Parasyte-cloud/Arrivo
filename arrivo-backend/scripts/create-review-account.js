// Creates the demo rider and demo driver that Apple and Google reviewers sign
// in with. Both stores require working credentials in the submission form, and
// a reviewer who cannot get past the login screen rejects the build.
//
// Run against whichever database the build points at. Staging is fine if the
// build points at staging; if the submitted build points at production, this
// has to run against production or the reviewer gets an invalid login.
//
//   REVIEW_ACCOUNT_PASSWORD=... node scripts/create-review-account.js
//   node scripts/create-review-account.js "a-strong-private-password"
//
// There is no default password. Supply one or it refuses to run.
//
// Safe to re-run. It resets the password and re-verifies the accounts rather
// than erroring on the second run, which is what you want the week before a
// resubmission when nobody remembers the password.
//
// Two things worth knowing before you paste these into App Store Connect:
//
//   1. The accounts are marked email_verified so a reviewer is never stuck
//      waiting on an inbox they do not have.
//   2. They are ordinary rider and driver accounts, NOT admin. A reviewer only
//      needs to see the app a real user sees.

require("dotenv").config();
const bcrypt = require("bcryptjs");

const RIDER_EMAIL = "appreview.rider@ridearrivo.com";
const DRIVER_EMAIL = "appreview.driver@ridearrivo.com";

// Supplied, never defaulted. A fallback baked into a public repository is a
// working login for two real accounts on production, so this fails closed
// instead. Pick something long, and rotate it between review rounds.
//
//   REVIEW_ACCOUNT_PASSWORD=... node scripts/create-review-account.js
//   node scripts/create-review-account.js "a-strong-private-password"
const password = process.env.REVIEW_ACCOUNT_PASSWORD || process.argv[2];

if (!password) {
  console.error(
    "REVIEW_ACCOUNT_PASSWORD or a password argument is required. Refusing to use a default."
  );
  process.exit(1);
}

// Short passwords get bounced by the stores and by our own signup rules.
if (String(password).length < 12) {
  console.error("That password is too short. Use at least 12 characters.");
  process.exit(1);
}

// Only now, so a missing password is reported instead of a database error.
const { pool, ready } = require("../db/db");

async function upsertReviewUser({ email, name, role, phone }) {
  const passwordHash = bcrypt.hashSync(password, 10);

  const existing = await pool.query("SELECT id, deleted_at FROM users WHERE email = $1", [email]);

  if (existing.rows[0]) {
    // Clearing deleted_at is belt and braces. Deleting an account also rewrites
    // its email to a tombstone, so a reviewer who deleted the account while
    // testing that flow will not be found by this lookup at all and simply gets
    // a fresh row on the next run. Either way they end up with working
    // credentials, which is the only thing the submission cares about.
    const updated = await pool.query(
      `UPDATE users
          SET password_hash = $2,
              name = $3,
              role = $4,
              phone = $5,
              agreed_to_terms = true,
              email_verified = true,
              deleted_at = NULL,
              wallet_balance_naira = 0
        WHERE email = $1
        RETURNING id`,
      [email, passwordHash, name, role, phone]
    );
    return { id: updated.rows[0].id, created: false, wasDeleted: !!existing.rows[0].deleted_at };
  }

  const inserted = await pool.query(
    `INSERT INTO users (name, email, phone, password_hash, role, agreed_to_terms, email_verified, preferred_language)
     VALUES ($1, $2, $3, $4, $5, true, true, 'en')
     RETURNING id`,
    [name, email, phone, passwordHash, role]
  );
  return { id: inserted.rows[0].id, created: true, wasDeleted: false };
}

(async () => {
  await ready;

  const rider = await upsertReviewUser({
    email: RIDER_EMAIL,
    name: "App Review Rider",
    role: "rider",
    phone: "+2348000000001",
  });

  const driver = await upsertReviewUser({
    email: DRIVER_EMAIL,
    name: "App Review Driver",
    role: "driver",
    phone: "+2348000000002",
  });

  // A driver with no drivers row cannot reach the driver app's main screens, so
  // the reviewer would sign in and see nothing. Verified so they skip the
  // pending-approval wall.
  await pool.query(
    `INSERT INTO drivers (user_id, license_number, lasdri_number, is_verified, spoken_languages)
     VALUES ($1, 'REVIEW-LIC-0001', 'REVIEW-LASDRI-0001', true, 'en')
     ON CONFLICT (user_id) DO UPDATE
        SET is_verified = true,
            license_number = 'REVIEW-LIC-0001',
            lasdri_number = 'REVIEW-LASDRI-0001'`,
    [driver.id]
  );

  const say = (label, r) =>
    `${label}: ${r.created ? "created" : r.wasDeleted ? "restored (had been deleted)" : "updated"} (user id ${r.id})`;

  console.log("");
  console.log(say("Rider", rider));
  console.log(say("Driver", driver));
  console.log("");
  console.log("Paste these into App Store Connect and Play Console:");
  console.log("");
  console.log(`  Rider   ${RIDER_EMAIL}`);
  console.log(`  Driver  ${DRIVER_EMAIL}`);
  console.log("  Password: the one you just supplied, not printed here.");
  console.log("");
  console.log("Both are email-verified so no inbox is needed. Neither is an admin.");
  console.log("");

  await pool.end();
})().catch((err) => {
  console.error("Could not create the review accounts:", err.message);
  process.exit(1);
});
