const fs = require("fs");
const path = require("path");

const routePath = path.join(__dirname, "support.js");
const schemaPath = path.join(__dirname, "..", "db", "schema.sql");

const route = fs.readFileSync(routePath, "utf8");
const schema = fs.readFileSync(schemaPath, "utf8");

let passed = 0;
let failed = 0;

function check(name, condition) {
  if (condition) {
    console.log(`PASS: ${name}`);
    passed++;
  } else {
    console.log(`FAIL: ${name}`);
    failed++;
  }
}

console.log("Support-assisted booking security contract:");

check(
  "dedicated assisted-booking POST route exists",
  /router\.post\(\s*["']\/assisted-bookings["']/.test(route)
);

check(
  "assisted booking is restricted to support/admin actors",
  /\/assisted-bookings[\s\S]{0,500}requireAnyRole\(\s*\[\s*["']admin["']\s*,\s*["']support["']\s*\]/.test(route)
  || /\/assisted-bookings[\s\S]{0,500}requireAnyRole\(\s*\[\s*["']support["']\s*,\s*["']admin["']\s*\]/.test(route)
);

check(
  "assisted booking requires trusted Workspace actor envelope",
  /\/assisted-bookings[\s\S]{0,900}requireWorkspaceActor/.test(route)
);

check(
  "assisted booking explicitly rejects non-Support/Admin Workspace actors",
  /workspaceActor\.role[\s\S]{0,500}(?:support|admin)[\s\S]{0,500}403/.test(route)
  || /(?:support|admin)[\s\S]{0,500}workspaceActor\.role[\s\S]{0,500}403/.test(route)
);

check(
  "assisted booking persists authenticated Workspace employee identity",
  /\/assisted-bookings[\s\S]{0,9000}workspaceActor\.employeeId/.test(route)
);

check(
  "authoritative fare engine is reused",
  /computeFare/.test(route)
);

check(
  "authoritative FX service is reused",
  /getNgnPerUsd/.test(route)
);

check(
  "durable assisted-booking provenance table exists",
  /CREATE TABLE IF NOT EXISTS support_assisted_bookings/i.test(schema)
  || /CREATE TABLE support_assisted_bookings/i.test(schema)
);

check(
  "Workspace employee actor and Arrivo rider are recorded separately",
  /support_assisted_bookings[\s\S]{0,3000}actor_employee_id/i.test(schema)
  && /support_assisted_bookings[\s\S]{0,3000}rider_id/i.test(schema)
);

check(
  "assisted-booking idempotency is durable and unique",
  /support_assisted_bookings[\s\S]{0,4000}idempotency_key/i.test(schema)
  && (
    /idempotency_key[^,\n]*(?:UNIQUE|unique)/.test(schema)
    || /UNIQUE[\s\S]{0,120}idempotency_key/i.test(schema)
  )
);

check(
  "pre-payment assisted booking does not require a ride row",
  /support_assisted_bookings[\s\S]{0,1600}ride_id\s+INTEGER\s+UNIQUE/i.test(schema)
  && !/support_assisted_bookings[\s\S]{0,1600}ride_id\s+INTEGER\s+NOT\s+NULL/i.test(schema)
);

check(
  "customer identity resolver handles ambiguity explicitly",
  /\/assisted-bookings[\s\S]{0,6000}(?:409|ambiguous|multiple matching)/i.test(route)
);

check(
  "assisted card booking is explicitly pending until payment confirmation",
  /\/assisted-bookings[\s\S]{0,9000}payment_status[\s\S]{0,160}pending/i.test(route)
);

check(
  "booking provenance identifies support-assisted source",
  /\/assisted-bookings[\s\S]{0,9000}(?:support_assisted|support-assisted|assisted_booking)/i.test(route)
);

check(
  "caller-supplied customer password is never required",
  !/\/assisted-bookings[\s\S]{0,3000}password_hash/i.test(route)
);

console.log(`ASSISTED_BOOKING_SECURITY_PASS=${passed}`);
console.log(`ASSISTED_BOOKING_SECURITY_FAIL=${failed}`);

if (failed > 0) {
  process.exitCode = 1;
}
