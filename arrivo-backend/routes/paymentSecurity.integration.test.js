// Payment and session security, against a real Postgres and the real routers.
// Each test is one finding from the audit, written as the attack it describes.
//
//   DATABASE_URL=postgres://localhost/... node routes/paymentSecurity.integration.test.js
//
// Paystack is never called for real: axios.get is replaced with a stub that
// records the URL it was asked for and answers like Paystack would.

const assert = require("assert");
const http = require("http");
const jwt = require("jsonwebtoken");
const axios = require("axios");

process.env.JWT_SECRET = process.env.JWT_SECRET || "integration-test-secret";
process.env.PAYSTACK_SECRET_KEY = "sk_test_stub_for_tests";
// Small limits so the rate-limit tests below can reach them (read at require time).
process.env.PAYMENT_INIT_RATE_LIMIT = "5";
process.env.PAYMENT_VERIFY_RATE_LIMIT = "60";

const express = require("express");
require("express-async-errors");
const { pool } = require("../db/db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { isValidPaystackReference } = require("../services/paymentReferences");
const payments = require("./payments");

const app = express();
app.use("/api/payments", payments); // the webhook reads the raw body itself
app.use(express.json());
app.use("/api/wallet", require("./wallet"));
app.use("/api/family", require("./family"));
app.use("/api/rides", require("./rides"));
app.get("/admin-only", requireAuth, requireRole("admin"), (req, res) => res.json({ ok: true, role: req.user.role }));
app.use((err, req, res, next) => res.status(500).json({ error: "server error", detail: err.message }));
const server = http.createServer(app);

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
    passed++;
  } catch (e) {
    console.log(`FAIL  ${name}`);
    console.log(`      ${e.stack || e.message}`);
    process.exitCode = 1;
  }
}

async function call(path, { method = "GET", token, body, headers = {} } = {}) {
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

// What the fake Paystack knows. Anything not listed answers "abandoned".
const transactions = new Map();
const outbound = [];
const realGet = axios.get;
axios.get = async (url) => {
  outbound.push(url);
  const match = /\/transaction\/verify\/([^/?]+)$/.exec(url);
  const reference = match ? decodeURIComponent(match[1]) : null;
  const tx = reference && transactions.get(reference);
  if (!tx) return { data: { data: { status: "abandoned", amount: 0, currency: "NGN" } } };
  return { data: { data: { status: "success", currency: "NGN", paid_at: new Date().toISOString(), ...tx } } };
};

const stamp = Date.now();
const made = [];
async function makeUser(tag, { role = "rider", wallet = 0, emailVerified = true } = {}) {
  const email = `paysec-${tag}-${stamp}-${Math.random().toString(36).slice(2)}@example.com`;
  const row = (
    await pool.query(
      `INSERT INTO users (name, email, password_hash, role, agreed_to_terms, email_verified, wallet_balance_naira)
       VALUES ($1, $2, 'x', $3, true, $4, $5) RETURNING id, token_version`,
      [`PaySec ${tag}`, email, role, emailVerified, wallet]
    )
  ).rows[0];
  made.push(row.id);
  const token = jwt.sign({ id: row.id, email, role, tv: row.token_version }, process.env.JWT_SECRET, { expiresIn: "1h" });
  return { id: row.id, email, token };
}

function rideBody(overrides) {
  return Object.assign(
    { pickupAddress: "Murtala Muhammed Airport", stops: ["Victoria Island, Lagos"], flightNumber: "TEST123", vehicleType: "sedan", bookingType: "one_way", agreedCancellationPolicy: true, adults: 1, children: 0 },
    overrides
  );
}

(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));

  console.log("Payment references:");

  await test("only plain Paystack references are accepted", () => {
    for (const ok of ["T123456789012345", "abc-DEF_12.3", "ref=ok1", "a1b2"]) assert.ok(isValidPaystackReference(ok), ok);
    for (const bad of ["../123456", "..", "...", "a/../b", "abc/def", "123?x=1", "a b c d", "", "abc", ".hidden1", "x".repeat(101), null, undefined, 123456, ["abcd"], { a: 1 }]) {
      assert.ok(!isValidPaystackReference(bad), `should refuse ${JSON.stringify(bad)}`);
    }
  });

  await test("the audit attack: '../<id>' on wallet top-up never reaches Paystack", async () => {
    const attacker = await makeUser("attacker");
    transactions.set("victim-ref-1", { amount: 5000000 });
    outbound.length = 0;
    for (const reference of ["../123456", "x/../../transaction/123", "..%2F123456", "123?x=1"]) {
      const r = await call("/api/wallet/topup/verify", { method: "POST", token: attacker.token, body: { reference } });
      assert.strictEqual(r.status, 400, `${reference}: ${JSON.stringify(r.body)}`);
    }
    assert.strictEqual(outbound.length, 0, `Paystack was asked: ${outbound.join(", ")}`);
    const bal = await pool.query("SELECT wallet_balance_naira FROM users WHERE id = $1", [attacker.id]);
    assert.strictEqual(Number(bal.rows[0].wallet_balance_naira), 0);
  });

  await test("a real reference still credits the wallet, once", async () => {
    const user = await makeUser("topup");
    transactions.set(`good-${stamp}-1`, { amount: 250000 });
    const first = await call("/api/wallet/topup/verify", { method: "POST", token: user.token, body: { reference: `good-${stamp}-1` } });
    assert.strictEqual(first.status, 200, JSON.stringify(first.body));
    assert.strictEqual(first.body.balanceNaira, 2500);
    const again = await call("/api/wallet/topup/verify", { method: "POST", token: user.token, body: { reference: `good-${stamp}-1` } });
    assert.strictEqual(again.body.alreadyCredited, true);
    const bal = await pool.query("SELECT wallet_balance_naira FROM users WHERE id = $1", [user.id]);
    assert.strictEqual(Number(bal.rows[0].wallet_balance_naira), 2500);
  });

  await test("a payment in another currency is not credited as naira", async () => {
    const user = await makeUser("usd");
    transactions.set(`usd-${stamp}`, { amount: 10000, currency: "USD" });
    const r = await call("/api/wallet/topup/verify", { method: "POST", token: user.token, body: { reference: `usd-${stamp}` } });
    assert.strictEqual(r.status, 400, JSON.stringify(r.body));
    const bal = await pool.query("SELECT wallet_balance_naira FROM users WHERE id = $1", [user.id]);
    assert.strictEqual(Number(bal.rows[0].wallet_balance_naira), 0);
  });

  await test("GET /payments/verify rejects a traversal reference without calling Paystack", async () => {
    outbound.length = 0;
    const r = await call("/api/payments/verify/..%2F..%2Ftransaction%2F1");
    assert.ok([400, 404].includes(r.status), String(r.status));
    const r2 = await call("/api/payments/verify/abc..def");
    assert.strictEqual(r2.status, 400);
    assert.strictEqual(outbound.length, 0, outbound.join(", "));
  });

  console.log("One payment, one use:");

  await test("a reference spent on a personal top-up cannot also fund a family wallet", async () => {
    const user = await makeUser("family-admin");
    const plan = (await pool.query(`INSERT INTO family_plans (admin_user_id, plan_type, max_members, price_naira, renews_at) VALUES ($1, 'plus', 3, 50000, now() + interval '30 days') RETURNING id`, [user.id])).rows[0].id;
    await pool.query(`INSERT INTO family_members (family_plan_id, user_id, member_role) VALUES ($1, $2, 'admin')`, [plan, user.id]);
    const reference = `once-${stamp}-a`;
    transactions.set(reference, { amount: 400000 });

    const personal = await call("/api/wallet/topup/verify", { method: "POST", token: user.token, body: { reference } });
    assert.strictEqual(personal.status, 200, JSON.stringify(personal.body));
    const family = await call(`/api/family/plans/${plan}/wallet/topup/verify`, { method: "POST", token: user.token, body: { reference } });
    assert.strictEqual(family.status, 400, JSON.stringify(family.body));
    const bal = await pool.query("SELECT wallet_balance_naira FROM family_plans WHERE id = $1", [plan]);
    assert.strictEqual(Number(bal.rows[0].wallet_balance_naira), 0, "the family wallet must not be credited");
  });

  await test("and the other way round: a family top-up cannot also fund a personal wallet", async () => {
    const user = await makeUser("family-admin2");
    const plan = (await pool.query(`INSERT INTO family_plans (admin_user_id, plan_type, max_members, price_naira, renews_at) VALUES ($1, 'plus', 3, 50000, now() + interval '30 days') RETURNING id`, [user.id])).rows[0].id;
    await pool.query(`INSERT INTO family_members (family_plan_id, user_id, member_role) VALUES ($1, $2, 'admin')`, [plan, user.id]);
    const reference = `once-${stamp}-b`;
    transactions.set(reference, { amount: 300000 });

    const family = await call(`/api/family/plans/${plan}/wallet/topup/verify`, { method: "POST", token: user.token, body: { reference } });
    assert.strictEqual(family.status, 200, JSON.stringify(family.body));
    assert.strictEqual(family.body.walletBalanceNaira, 3000);
    const personal = await call("/api/wallet/topup/verify", { method: "POST", token: user.token, body: { reference } });
    assert.strictEqual(personal.status, 400, JSON.stringify(personal.body));
    const bal = await pool.query("SELECT wallet_balance_naira FROM users WHERE id = $1", [user.id]);
    assert.strictEqual(Number(bal.rows[0].wallet_balance_naira), 0);
  });

  console.log("Card rides need a real payment:");

  async function fareFor(user) {
    const q = await call("/api/rides", { method: "POST", token: user.token, body: rideBody({ paymentMethod: "card", validateOnly: true }) });
    assert.strictEqual(q.status, 200, JSON.stringify(q.body));
    const fare = Number(q.body.fareNaira ?? q.body.fare_naira ?? q.body.quote?.fareNaira);
    assert.ok(fare > 0, `could not read the fare from ${JSON.stringify(q.body)}`);
    return fare;
  }

  await test("no reference, a made-up reference and an unpaid reference all fail, and no ride exists", async () => {
    const rider = await makeUser("card-rider");
    for (const paymentReference of [undefined, `made-up-${stamp}`]) {
      const r = await call("/api/rides", { method: "POST", token: rider.token, body: rideBody({ paymentMethod: "card", paymentReference }) });
      assert.strictEqual(r.status, 400, JSON.stringify(r.body));
    }
    const n = await pool.query("SELECT count(*)::int n FROM rides WHERE rider_id = $1", [rider.id]);
    assert.strictEqual(n.rows[0].n, 0);
  });

  await test("underpaying is refused; paying the fare books a ride that is already paid", async () => {
    const rider = await makeUser("card-rider2");
    const fare = await fareFor(rider);

    transactions.set(`short-${stamp}`, { amount: (fare - 1000) * 100 });
    const short = await call("/api/rides", { method: "POST", token: rider.token, body: rideBody({ paymentMethod: "card", paymentReference: `short-${stamp}` }) });
    assert.strictEqual(short.status, 400, JSON.stringify(short.body));

    transactions.set(`full-${stamp}`, { amount: fare * 100 });
    const ok = await call("/api/rides", { method: "POST", token: rider.token, body: rideBody({ paymentMethod: "card", paymentReference: `full-${stamp}` }) });
    assert.strictEqual(ok.status, 201, JSON.stringify(ok.body));
    assert.strictEqual(ok.body.ride.payment_status, "paid");
    assert.strictEqual(Number(ok.body.ride.fare_naira), fare);
  });

  await test("a retry of the same card booking returns the same ride, not an error", async () => {
    const rider = await makeUser("card-rider3");
    const fare = await fareFor(rider);
    transactions.set(`twice-${stamp}`, { amount: fare * 100 });
    const first = await call("/api/rides", { method: "POST", token: rider.token, body: rideBody({ paymentMethod: "card", paymentReference: `twice-${stamp}` }) });
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const second = await call("/api/rides", { method: "POST", token: rider.token, body: rideBody({ paymentMethod: "card", paymentReference: `twice-${stamp}` }) });
    assert.strictEqual(second.status, 200, JSON.stringify(second.body));
    assert.strictEqual(second.body.replayed, true);
    assert.strictEqual(second.body.ride.id, first.body.ride.id);
    const n = await pool.query("SELECT count(*)::int n FROM rides WHERE rider_id = $1", [rider.id]);
    assert.strictEqual(n.rows[0].n, 1);
  });

  await test("simultaneous retries of one card booking create exactly one ride", async () => {
    const rider = await makeUser("card-rider3b");
    const fare = await fareFor(rider);
    transactions.set(`race-${stamp}`, { amount: fare * 100 });
    const body = rideBody({ paymentMethod: "card", paymentReference: `race-${stamp}` });
    const results = await Promise.all([1, 2, 3].map(() => call("/api/rides", { method: "POST", token: rider.token, body })));
    for (const r of results) assert.ok(r.status === 200 || r.status === 201, JSON.stringify(r.body));
    assert.strictEqual(new Set(results.map((r) => r.body.ride.id)).size, 1);
    const n = await pool.query("SELECT count(*)::int n FROM rides WHERE rider_id = $1", [rider.id]);
    assert.strictEqual(n.rows[0].n, 1);
  });

  await test("another rider cannot reuse someone else's paid reference", async () => {
    const owner = await makeUser("card-rider3c");
    const thief = await makeUser("card-rider3d");
    const fare = await fareFor(owner);
    transactions.set(`steal-${stamp}`, { amount: fare * 100 });
    const first = await call("/api/rides", { method: "POST", token: owner.token, body: rideBody({ paymentMethod: "card", paymentReference: `steal-${stamp}` }) });
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const second = await call("/api/rides", { method: "POST", token: thief.token, body: rideBody({ paymentMethod: "card", paymentReference: `steal-${stamp}` }) });
    assert.strictEqual(second.status, 400, JSON.stringify(second.body));
    const n = await pool.query("SELECT count(*)::int n FROM rides WHERE rider_id = $1", [thief.id]);
    assert.strictEqual(n.rows[0].n, 0);
  });

  await test("a payment in the wrong currency does not book a ride", async () => {
    const rider = await makeUser("card-rider4");
    const fare = await fareFor(rider);
    transactions.set(`usdride-${stamp}`, { amount: fare * 100, currency: "USD" });
    const r = await call("/api/rides", { method: "POST", token: rider.token, body: rideBody({ paymentMethod: "card", paymentReference: `usdride-${stamp}` }) });
    assert.strictEqual(r.status, 400, JSON.stringify(r.body));
  });

  console.log("The driver queue:");

  await test("an unapproved driver sees an empty queue; an approved one sees rides without private fields", async () => {
    const rider = await makeUser("queue-rider", { wallet: 1000000 });
    const booked = await call("/api/rides", { method: "POST", token: rider.token, body: rideBody({ paymentMethod: "wallet", idempotencyKey: `q-${stamp}` }) });
    assert.strictEqual(booked.status, 201, JSON.stringify(booked.body));
    await pool.query("UPDATE rides SET admin_notes = 'internal note', share_token = 'tok' WHERE id = $1", [booked.body.ride.id]);

    const driverUser = await makeUser("queue-driver", { role: "driver" });
    const driverRow = (await pool.query(`INSERT INTO drivers (user_id, is_verified) VALUES ($1, false) RETURNING id`, [driverUser.id]).catch(() => ({ rows: [] }))).rows[0];
    assert.ok(driverRow, "could not create a driver row for the test");

    const pending = await call("/api/rides/available", { token: driverUser.token });
    assert.strictEqual(pending.status, 200);
    assert.deepStrictEqual(pending.body.rides, []);
    assert.strictEqual(pending.body.pendingVerification, true);

    await pool.query("UPDATE drivers SET is_verified = true WHERE id = $1", [driverRow.id]);
    const live = await call("/api/rides/available", { token: driverUser.token });
    assert.strictEqual(live.status, 200);
    const mine = live.body.rides.find((x) => x.id === booked.body.ride.id);
    assert.ok(mine, "the approved driver should see the open ride");
    for (const hidden of ["admin_notes", "share_token", "payment_reference"]) assert.ok(!(hidden in mine), `${hidden} must not be sent to drivers`);
  });

  console.log("Sessions follow the database:");

  await test("a token that says admin does not make a demoted user an admin", async () => {
    const user = await makeUser("demoted", { role: "rider" });
    const forged = jwt.sign({ id: user.id, email: user.email, role: "admin", tv: 0 }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const r = await call("/admin-only", { token: forged });
    assert.strictEqual(r.status, 403, JSON.stringify(r.body));
  });

  await test("promotion and demotion apply at once, without a new token", async () => {
    const user = await makeUser("promoted", { role: "admin" });
    assert.strictEqual((await call("/admin-only", { token: user.token })).status, 200);
    await pool.query("UPDATE users SET role = 'rider' WHERE id = $1", [user.id]);
    assert.strictEqual((await call("/admin-only", { token: user.token })).status, 403);
  });

  await test("raising token_version ends every existing session; old tokens without it still work until then", async () => {
    const user = await makeUser("tv", { role: "admin" });
    const legacy = jwt.sign({ id: user.id, email: user.email, role: "admin" }, process.env.JWT_SECRET, { expiresIn: "1h" });
    assert.strictEqual((await call("/admin-only", { token: legacy })).status, 200, "a token issued before this change still works");
    await pool.query("UPDATE users SET token_version = token_version + 1 WHERE id = $1", [user.id]);
    assert.strictEqual((await call("/admin-only", { token: legacy })).status, 401);
    assert.strictEqual((await call("/admin-only", { token: user.token })).status, 401);
    const fresh = jwt.sign({ id: user.id, email: user.email, role: "admin", tv: 1 }, process.env.JWT_SECRET, { expiresIn: "1h" });
    assert.strictEqual((await call("/admin-only", { token: fresh })).status, 200);
  });

  console.log("Webhook:");

  await test("the Paystack webhook is refused outright when no secret key is configured", async () => {
    const keep = process.env.PAYSTACK_SECRET_KEY;
    delete process.env.PAYSTACK_SECRET_KEY;
    try {
      const body = JSON.stringify({ event: "charge.success", data: { reference: "forged-1", amount: 1, customer: { email: "a@b.c" } } });
      // The signature an attacker could compute when the key defaults to "".
      const sig = require("crypto").createHmac("sha512", "").update(body).digest("hex");
      const r = await call("/api/payments/webhook", { method: "POST", body, headers: { "x-paystack-signature": sig } });
      assert.strictEqual(r.status, 503);
    } finally {
      process.env.PAYSTACK_SECRET_KEY = keep;
    }
  });

  await test("PAYMENT_ROUTES_REQUIRE_AUTH=true needs a signed-in rider on initialize and verify", async () => {
    const rider = await makeUser("pay-auth");
    process.env.PAYMENT_ROUTES_REQUIRE_AUTH = "true";
    try {
      const anonVerify = await call(`/api/payments/verify/auth-${stamp}`);
      assert.strictEqual(anonVerify.status, 401, JSON.stringify(anonVerify.body));
      const anonInit = await call("/api/payments/initialize", { method: "POST", body: {} });
      assert.strictEqual(anonInit.status, 401, JSON.stringify(anonInit.body));
      const signedVerify = await call(`/api/payments/verify/auth-${stamp}`, { token: rider.token });
      assert.strictEqual(signedVerify.status, 200, JSON.stringify(signedVerify.body));
    } finally {
      delete process.env.PAYMENT_ROUTES_REQUIRE_AUTH;
    }
  });

  console.log("Payment route rate limits:");

  await test("/initialize is rate limited per IP and answers { error }", async () => {
    let limited = null;
    let before = 0;
    for (let i = 0; i < 12 && !limited; i++) {
      const r = await call("/api/payments/initialize", { method: "POST", body: {} });
      if (r.status === 429) limited = r; else before++;
    }
    assert.ok(limited, "never rate limited");
    assert.ok(before >= 1, "limited before any request was allowed");
    assert.ok(limited.body.error);
  });

  await test("/verify is rate limited per IP", async () => {
    let limited = null;
    for (let i = 0; i < 70 && !limited; i++) {
      const r = await call(`/api/payments/verify/rl-${stamp}-${i}`);
      if (r.status === 429) limited = r;
    }
    assert.ok(limited, "never rate limited");
    assert.ok(limited.body.error);
  });

  for (const id of [...new Set(made)]) {
    await pool.query("DELETE FROM used_payment_references WHERE ride_id IN (SELECT id FROM rides WHERE rider_id = $1)", [id]).catch(() => {});
    await pool.query("DELETE FROM wallet_transactions WHERE user_id = $1", [id]).catch(() => {});
    await pool.query("DELETE FROM family_wallet_transactions WHERE actor_user_id = $1", [id]).catch(() => {});
    await pool.query("DELETE FROM ride_idempotency_keys WHERE user_id = $1", [id]).catch(() => {});
    await pool.query("DELETE FROM rides WHERE rider_id = $1", [id]).catch(() => {});
    await pool.query("DELETE FROM family_members WHERE user_id = $1", [id]).catch(() => {});
    await pool.query("DELETE FROM family_plans WHERE admin_user_id = $1", [id]).catch(() => {});
    await pool.query("DELETE FROM drivers WHERE user_id = $1", [id]).catch(() => {});
    await pool.query("DELETE FROM users WHERE id = $1", [id]).catch(() => {});
  }
  await pool.query("DELETE FROM used_payment_references WHERE reference LIKE $1 OR reference LIKE $2 OR reference LIKE $3", [`%-${stamp}%`, `once-${stamp}%`, `good-${stamp}%`]).catch(() => {});

  axios.get = realGet;
  server.close();
  await pool.end();
  console.log(`\n${passed} passed`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
