// Route-level tests against a REAL Postgres and the real Express app, for
// the ride-booking idempotency work in POST /api/rides (wallet,
// family_wallet, membership) -- see services/idempotency.js and the
// ride_idempotency_keys table in db/schema.sql.
//
//   DATABASE_URL=postgres://... node routes/rides.idempotency.integration.test.js
//   npm run test:integration
//
// These exist to prove the actual failure mode from the review: a lost
// response followed by a retried POST /api/rides must not debit money (or
// insert a ride) twice, concurrent retries must not race past each other,
// and reusing a key for a materially different booking must be refused
// rather than silently replaying the wrong ride.

const assert = require("assert");
const http = require("http");
const jwt = require("jsonwebtoken");

process.env.JWT_SECRET = process.env.JWT_SECRET || "integration-test-secret";
// No AVIATIONSTACK_KEY / GOOGLE_MAPS_SERVER_KEY on purpose -- both lookups
// in POST /api/rides are non-blocking best-effort calls (see routes/rides.js),
// and leaving these unset keeps the test from making real network calls.

const express = require("express");
require("express-async-errors");
const { pool } = require("../db/db");

let passed = 0;
function test(name, fn) {
  return (async () => {
    try {
      await fn();
      console.log(`  ok  ${name}`);
      passed++;
    } catch (e) {
      console.log(`FAIL  ${name}`);
      console.log(`      ${e.stack || e.message}`);
      process.exitCode = 1;
    }
  })();
}

const ridesRouter = require("./rides");
const app = express();
app.use(express.json());
app.use("/api/rides", ridesRouter);
app.use((err, req, res, next) => res.status(500).json({ error: "server error", detail: err.message }));
const server = http.createServer(app);

async function call(path, { method = "GET", token, body } = {}) {
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const stamp = Date.now();
const madeUsers = [];

// Bypasses signup entirely (no rate limiting to fight, no email service to
// stub) -- these tests only need a real user row and a real, validly signed
// token, exactly what requireAuth checks.
async function makeRider(tag, { walletBalance = 0 } = {}) {
  const email = `idem-${tag}-${stamp}-${Math.random().toString(36).slice(2)}@example.com`;
  const inserted = await pool.query(
    `INSERT INTO users (name, email, password_hash, role, agreed_to_terms, email_verified, wallet_balance_naira)
     VALUES ($1, $2, 'test-hash', 'rider', true, true, $3) RETURNING id`,
    [`Idem ${tag}`, email, walletBalance]
  );
  const id = inserted.rows[0].id;
  madeUsers.push(id);
  const token = jwt.sign({ id, email, role: "rider" }, process.env.JWT_SECRET, { expiresIn: "1h" });
  return { id, email, token };
}

async function makeFamilyPlan(adminUserId, { walletBalance = 0 } = {}) {
  const plan = await pool.query(
    `INSERT INTO family_plans (admin_user_id, plan_type, max_members, price_naira, wallet_balance_naira, renews_at)
     VALUES ($1, 'plus', 3, 50000, $2, now() + interval '30 days') RETURNING id`,
    [adminUserId, walletBalance]
  );
  const planId = plan.rows[0].id;
  await pool.query(
    `INSERT INTO family_members (family_plan_id, user_id, member_role) VALUES ($1, $2, 'admin')`,
    [planId, adminUserId]
  );
  return planId;
}

async function makeMembership(userId) {
  await pool.query(
    `INSERT INTO memberships (user_id, plan_type, expires_at, price_naira)
     VALUES ($1, 'individual_annual', now() + interval '30 days', 500000)`,
    [userId]
  );
}

// One place that builds a valid one_way booking body -- mirrors what
// booking.js's buildRidePayload actually sends. Every test starts from this
// and overrides just what it needs (payment method, idempotency key).
function rideBody(overrides) {
  return Object.assign({
    pickupAddress: "Murtala Muhammed Airport",
    stops: ["Victoria Island, Lagos"],
    flightNumber: "TEST123",
    vehicleType: "sedan",
    bookingType: "one_way",
    agreedCancellationPolicy: true,
    adults: 1,
    children: 0,
  }, overrides);
}

function randomKey() {
  return `test-key-${Math.random().toString(36).slice(2)}`;
}

(async () => {
await new Promise((r) => server.listen(0, "127.0.0.1", r));

console.log("idempotencyKey is required for money-moving payment methods:");

await test("wallet booking without an idempotencyKey is rejected", async () => {
  const rider = await makeRider("no-key-wallet", { walletBalance: 100000 });
  const r = await call("/api/rides", { method: "POST", token: rider.token, body: rideBody({ paymentMethod: "wallet" }) });
  assert.strictEqual(r.status, 400, JSON.stringify(r.body));
  assert.ok(/idempotencyKey/.test(r.body.error), `expected an idempotencyKey error, got ${JSON.stringify(r.body)}`);
});

await test("card booking does not require an idempotencyKey", async () => {
  const rider = await makeRider("no-key-card");
  const r = await call("/api/rides", { method: "POST", token: rider.token, body: rideBody({ paymentMethod: "card" }) });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
});

console.log("");
console.log("A lost response followed by a retry does not double-charge the wallet:");

await test("same key retried after commit replays the original ride, one debit only", async () => {
  const rider = await makeRider("wallet-retry", { walletBalance: 100000 });
  const key = randomKey();
  const body = rideBody({ paymentMethod: "wallet", idempotencyKey: key });

  const first = await call("/api/rides", { method: "POST", token: rider.token, body });
  assert.strictEqual(first.status, 201, JSON.stringify(first.body));

  const balanceAfterFirst = await pool.query("SELECT wallet_balance_naira FROM users WHERE id = $1", [rider.id]);
  const debited = 100000 - Number(balanceAfterFirst.rows[0].wallet_balance_naira);
  assert.ok(debited > 0, "the fare should have left the wallet");

  // Simulates the website retrying after the ORIGINAL response was lost --
  // same idempotencyKey, same booking.
  const retry = await call("/api/rides", { method: "POST", token: rider.token, body });
  assert.strictEqual(retry.status, 201, JSON.stringify(retry.body));
  assert.strictEqual(retry.body.ride.id, first.body.ride.id, "a retry must return the SAME ride, not create a new one");

  const balanceAfterRetry = await pool.query("SELECT wallet_balance_naira FROM users WHERE id = $1", [rider.id]);
  assert.strictEqual(
    Number(balanceAfterRetry.rows[0].wallet_balance_naira),
    Number(balanceAfterFirst.rows[0].wallet_balance_naira),
    "the wallet must not be debited a second time on replay"
  );

  const rideCount = await pool.query("SELECT count(*)::int AS n FROM rides WHERE rider_id = $1 AND payment_method = 'wallet'", [rider.id]);
  assert.strictEqual(rideCount.rows[0].n, 1, "exactly one ride should exist for this attempt");
});

console.log("");
console.log("Two concurrent requests with the same key never both win:");

await test("concurrent wallet requests with the same key produce exactly one ride and one debit", async () => {
  const rider = await makeRider("wallet-concurrent", { walletBalance: 100000 });
  const key = randomKey();
  const body = rideBody({ paymentMethod: "wallet", idempotencyKey: key });

  const [a, b] = await Promise.all([
    call("/api/rides", { method: "POST", token: rider.token, body }),
    call("/api/rides", { method: "POST", token: rider.token, body }),
  ]);

  assert.strictEqual(a.status, 201, JSON.stringify(a.body));
  assert.strictEqual(b.status, 201, JSON.stringify(b.body));
  assert.strictEqual(a.body.ride.id, b.body.ride.id, "both concurrent requests must resolve to the SAME ride");

  const rideCount = await pool.query("SELECT count(*)::int AS n FROM rides WHERE rider_id = $1 AND payment_method = 'wallet'", [rider.id]);
  assert.strictEqual(rideCount.rows[0].n, 1, "concurrent retries must not create two rides");

  const balance = await pool.query("SELECT wallet_balance_naira FROM users WHERE id = $1", [rider.id]);
  const debited = 100000 - Number(balance.rows[0].wallet_balance_naira);
  const fare = Number(a.body.ride.fare_naira);
  assert.strictEqual(debited, fare, "the wallet must be debited exactly once, not twice");
});

console.log("");
console.log("The same key reused for a different booking is refused, not silently replayed:");

await test("same key, different fare-relevant fields -> 409 conflict, no second ride", async () => {
  const rider = await makeRider("wallet-conflict", { walletBalance: 200000 });
  const key = randomKey();

  const first = await call("/api/rides", { method: "POST", token: rider.token, body: rideBody({ paymentMethod: "wallet", idempotencyKey: key, stops: ["Victoria Island, Lagos"] }) });
  assert.strictEqual(first.status, 201, JSON.stringify(first.body));

  const conflicting = await call("/api/rides", { method: "POST", token: rider.token, body: rideBody({ paymentMethod: "wallet", idempotencyKey: key, stops: ["Lekki Phase 1, Lagos"] }) });
  assert.strictEqual(conflicting.status, 409, JSON.stringify(conflicting.body));
  assert.strictEqual(conflicting.body.reason, "idempotency_key_reused_for_different_booking");

  const rideCount = await pool.query("SELECT count(*)::int AS n FROM rides WHERE rider_id = $1 AND payment_method = 'wallet'", [rider.id]);
  assert.strictEqual(rideCount.rows[0].n, 1, "the conflicting request must not have booked a second ride");
});

console.log("");
console.log("validateOnly never consumes the real booking key:");

await test("validateOnly with the same key that's about to book for real does not block the real booking", async () => {
  const rider = await makeRider("wallet-validate-only", { walletBalance: 100000 });
  const key = randomKey();

  const validate = await call("/api/rides", { method: "POST", token: rider.token, body: rideBody({ paymentMethod: "wallet", idempotencyKey: key, validateOnly: true }) });
  assert.strictEqual(validate.status, 200, JSON.stringify(validate.body));
  assert.strictEqual(validate.body.ok, true);

  const keyRow = await pool.query("SELECT id FROM ride_idempotency_keys WHERE idempotency_key = $1", [key]);
  assert.strictEqual(keyRow.rows.length, 0, "validateOnly must not create an idempotency-key row at all");

  const real = await call("/api/rides", { method: "POST", token: rider.token, body: rideBody({ paymentMethod: "wallet", idempotencyKey: key }) });
  assert.strictEqual(real.status, 201, JSON.stringify(real.body));

  // The same key can still be retried after the real booking and replay it.
  const retry = await call("/api/rides", { method: "POST", token: rider.token, body: rideBody({ paymentMethod: "wallet", idempotencyKey: key }) });
  assert.strictEqual(retry.status, 201);
  assert.strictEqual(retry.body.ride.id, real.body.ride.id);
});

console.log("");
console.log("A failed attempt frees the key for a genuinely fresh retry:");

await test("insufficient balance rolls back the idempotency claim, so a later top-up + retry succeeds", async () => {
  const rider = await makeRider("wallet-insufficient", { walletBalance: 100 });
  const key = randomKey();
  const body = rideBody({ paymentMethod: "wallet", idempotencyKey: key });

  const rejected = await call("/api/rides", { method: "POST", token: rider.token, body });
  assert.strictEqual(rejected.status, 400, JSON.stringify(rejected.body));
  assert.ok(/[Ii]nsufficient/.test(rejected.body.error));

  await pool.query("UPDATE users SET wallet_balance_naira = 100000 WHERE id = $1", [rider.id]);

  const retry = await call("/api/rides", { method: "POST", token: rider.token, body });
  assert.strictEqual(retry.status, 201, JSON.stringify(retry.body));

  const rideCount = await pool.query("SELECT count(*)::int AS n FROM rides WHERE rider_id = $1", [rider.id]);
  assert.strictEqual(rideCount.rows[0].n, 1, "the failed attempt must not have left a stray ride or a stuck key");
});

console.log("");
console.log("Family wallet replay behaves the same way as the personal wallet:");

await test("family_wallet: same key retried replays the ride, debits the plan once", async () => {
  const admin = await makeRider("family-admin");
  const planId = await makeFamilyPlan(admin.id, { walletBalance: 100000 });
  const key = randomKey();
  const body = rideBody({ paymentMethod: "family_wallet", idempotencyKey: key });

  const first = await call("/api/rides", { method: "POST", token: admin.token, body });
  assert.strictEqual(first.status, 201, JSON.stringify(first.body));

  const retry = await call("/api/rides", { method: "POST", token: admin.token, body });
  assert.strictEqual(retry.status, 201, JSON.stringify(retry.body));
  assert.strictEqual(retry.body.ride.id, first.body.ride.id);

  const plan = await pool.query("SELECT wallet_balance_naira FROM family_plans WHERE id = $1", [planId]);
  const fare = Number(first.body.ride.fare_naira);
  assert.strictEqual(Number(plan.rows[0].wallet_balance_naira), 100000 - fare, "the family wallet must be debited exactly once");

  const txCount = await pool.query("SELECT count(*)::int AS n FROM family_wallet_transactions WHERE family_plan_id = $1", [planId]);
  assert.strictEqual(txCount.rows[0].n, 1, "exactly one ledger entry should exist for this attempt");
});

console.log("");
console.log("Membership replay behaves the same way:");

await test("membership: same key retried replays the ride, does not book twice", async () => {
  const rider = await makeRider("membership-retry");
  await makeMembership(rider.id);
  const key = randomKey();
  const body = rideBody({ paymentMethod: "membership", idempotencyKey: key });

  const first = await call("/api/rides", { method: "POST", token: rider.token, body });
  assert.strictEqual(first.status, 201, JSON.stringify(first.body));

  const retry = await call("/api/rides", { method: "POST", token: rider.token, body });
  assert.strictEqual(retry.status, 201, JSON.stringify(retry.body));
  assert.strictEqual(retry.body.ride.id, first.body.ride.id);

  const rideCount = await pool.query("SELECT count(*)::int AS n FROM rides WHERE rider_id = $1 AND payment_method = 'membership'", [rider.id]);
  assert.strictEqual(rideCount.rows[0].n, 1);
});

// Leave the database roughly as we found it.
for (const id of [...new Set(madeUsers)]) {
  await pool.query("DELETE FROM ride_idempotency_keys WHERE user_id = $1", [id]).catch(() => {});
  await pool.query("DELETE FROM family_wallet_transactions WHERE actor_user_id = $1", [id]).catch(() => {});
  await pool.query("DELETE FROM wallet_transactions WHERE user_id = $1", [id]).catch(() => {});
  await pool.query("DELETE FROM rides WHERE rider_id = $1", [id]).catch(() => {});
  await pool.query("DELETE FROM family_members WHERE user_id = $1", [id]).catch(() => {});
  await pool.query("DELETE FROM family_plans WHERE admin_user_id = $1", [id]).catch(() => {});
  await pool.query("DELETE FROM memberships WHERE user_id = $1", [id]).catch(() => {});
  await pool.query("DELETE FROM users WHERE id = $1", [id]).catch(() => {});
}

server.close();
await pool.end();
console.log(`\n${passed} passed`);
})();
