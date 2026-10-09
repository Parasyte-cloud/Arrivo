// Payments safety, batch 2, against a real Postgres and the real routers.
//
//   DATABASE_URL=postgres://localhost/... node routes/paymentsBatch2.integration.test.js
//
// Paystack is never called for real: axios.get (verify) and axios.post
// (initialize, refund) are replaced with stubs that behave like Paystack.

const assert = require("assert");
const http = require("http");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const axios = require("axios");

process.env.JWT_SECRET = process.env.JWT_SECRET || "integration-test-secret-0123456789abcdef";
process.env.PAYSTACK_SECRET_KEY = "sk_test_stub_for_tests";
process.env.PAYMENT_INIT_RATE_LIMIT = "200";
process.env.PAYMENT_VERIFY_RATE_LIMIT = "200";

const express = require("express");
require("express-async-errors");
const { pool } = require("../db/db");
const payments = require("./payments");
const { sweepUnmatchedPayments } = require("../services/scheduler");

// Wired like server.js: JSON everywhere except the webhook, which needs the raw body.
const app = express();
app.use((req, res, next) => (req.originalUrl === "/api/payments/webhook" ? next() : express.json({ limit: "6mb" })(req, res, next)));
app.use("/api/payments", payments);
app.use("/api/wallet", require("./wallet"));
app.use("/api/rides", require("./rides"));
app.use("/api/memberships", require("./memberships"));
app.use("/api/admin/payment-exceptions", require("./paymentExceptions"));
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

function webhook(data, { event = "charge.success", key = process.env.PAYSTACK_SECRET_KEY } = {}) {
  const raw = JSON.stringify({ event, data });
  const sig = crypto.createHmac("sha512", key).update(raw).digest("hex");
  return call("/api/payments/webhook", { method: "POST", body: raw, headers: { "x-paystack-signature": sig } });
}

// ── fake Paystack ──
const transactions = new Map();
const refunds = [];
const initBodies = [];
let initCounter = 0;
let failNextRefund = false;
const realGet = axios.get;
const realPost = axios.post;
axios.get = async (url) => {
  const match = /\/transaction\/verify\/([^/?]+)$/.exec(url);
  const reference = match ? decodeURIComponent(match[1]) : null;
  const tx = reference && transactions.get(reference);
  if (!tx) return { data: { data: { status: "abandoned", amount: 0, currency: "NGN" } } };
  return { data: { data: { status: "success", currency: "NGN", paid_at: new Date().toISOString(), ...tx } } };
};
axios.post = async (url, body) => {
  if (url.endsWith("/transaction/initialize")) {
    initBodies.push(body);
    const reference = `b2init-${stamp}-${++initCounter}`;
    return { data: { data: { authorization_url: `https://checkout.paystack.test/${reference}`, access_code: "ac", reference } } };
  }
  if (url.endsWith("/refund")) {
    if (failNextRefund) {
      failNextRefund = false;
      throw Object.assign(new Error("Paystack said no"), { response: { data: { message: "Paystack said no" } } });
    }
    refunds.push(body);
    return { data: { data: { status: "pending", transaction: { reference: body.transaction } } } };
  }
  throw new Error(`unexpected POST ${url}`);
};

const stamp = Date.now();
const made = [];
async function makeUser(tag, { role = "rider", wallet = 0 } = {}) {
  const email = `b2-${tag}-${stamp}-${Math.random().toString(36).slice(2)}@example.com`;
  const row = (
    await pool.query(
      `INSERT INTO users (name, email, password_hash, role, agreed_to_terms, email_verified, wallet_balance_naira)
       VALUES ($1, $2, 'x', $3, true, true, $4) RETURNING id, token_version`,
      [`B2 ${tag}`, email, role, wallet]
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
async function fareFor(user) {
  const q = await call("/api/rides", { method: "POST", token: user.token, body: rideBody({ paymentMethod: "card", validateOnly: true }) });
  assert.strictEqual(q.status, 200, JSON.stringify(q.body));
  return Number(q.body.fareNaira);
}
const orderOf = async (ref) => (await pool.query("SELECT * FROM payment_orders WHERE reference = $1", [ref])).rows[0];
const exceptionsOf = async (ref) => (await pool.query("SELECT * FROM payment_exceptions WHERE reference = $1 ORDER BY id", [ref])).rows;
const balanceOf = async (id) => Number((await pool.query("SELECT wallet_balance_naira FROM users WHERE id = $1", [id])).rows[0].wallet_balance_naira);
const ridesFor = async (ref) => (await pool.query("SELECT * FROM rides WHERE payment_reference = $1", [ref])).rows;

(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));

  console.log("Initialize remembers the order:");

  await test("a signed-in top-up is stored against the verified user, in naira", async () => {
    const user = await makeUser("init1");
    const r = await call("/api/payments/initialize", { method: "POST", token: user.token, body: { email: user.email, amountNaira: 5000, purpose: "wallet_topup" } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(initBodies[initBodies.length - 1].currency, "NGN");
    const order = await orderOf(r.body.reference);
    assert.strictEqual(order.user_id, user.id);
    assert.strictEqual(order.purpose, "wallet_topup");
    assert.strictEqual(Number(order.amount_naira), 5000);
    assert.strictEqual(order.status, "pending");
  });

  await test("an old build with no token still works and the order is anonymous", async () => {
    const r = await call("/api/payments/initialize", { method: "POST", body: { email: "old@example.com", amountNaira: 1200 } });
    assert.strictEqual(r.status, 200);
    const order = await orderOf(r.body.reference);
    assert.strictEqual(order.user_id, null);
    assert.strictEqual(order.purpose, "unknown");
  });

  await test("anonymous callers cannot aim a payment at an account or store a booking", async () => {
    const victim = await makeUser("victim");
    const r = await call("/api/payments/initialize", { method: "POST", body: { email: victim.email, amountNaira: 3000, purpose: "wallet_topup", booking: rideBody({}), userId: victim.id } });
    assert.strictEqual(r.status, 200);
    const order = await orderOf(r.body.reference);
    assert.strictEqual(order.user_id, null);
    assert.strictEqual(order.purpose, "unknown");
    assert.strictEqual(order.payload, null);
  });

  await test("an expired or garbage token does not break payment: it is treated as anonymous", async () => {
    const r = await call("/api/payments/initialize", { method: "POST", token: "not.a.token", body: { email: "x@example.com", amountNaira: 1000, purpose: "wallet_topup" } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await orderOf(r.body.reference)).user_id, null);
  });

  console.log("The webhook finishes what the app did not:");

  await test("a wallet top-up is credited by the webhook alone, exactly once", async () => {
    const user = await makeUser("hooktopup");
    const init = await call("/api/payments/initialize", { method: "POST", token: user.token, body: { email: user.email, amountNaira: 7500, purpose: "wallet_topup" } });
    const ref = init.body.reference;
    const data = { reference: ref, amount: 750000, currency: "NGN", customer: { email: user.email } };
    assert.strictEqual((await webhook(data)).status, 200);
    assert.strictEqual(await balanceOf(user.id), 7500);
    assert.strictEqual((await webhook(data)).status, 200); // Paystack redelivers
    assert.strictEqual(await balanceOf(user.id), 7500, "a redelivery must not credit again");
    assert.strictEqual((await orderOf(ref)).status, "finalized");
    // The app then comes back and asks too: it is told it was already done.
    transactions.set(ref, { amount: 750000 });
    const verify = await call("/api/wallet/topup/verify", { method: "POST", token: user.token, body: { reference: ref } });
    assert.strictEqual(verify.status, 200);
    assert.strictEqual(verify.body.alreadyCredited, true);
    assert.strictEqual(await balanceOf(user.id), 7500);
  });

  await test("the other order works too: the app credits first, the webhook then does nothing", async () => {
    const user = await makeUser("apptopup");
    const init = await call("/api/payments/initialize", { method: "POST", token: user.token, body: { email: user.email, amountNaira: 2000, purpose: "wallet_topup" } });
    const ref = init.body.reference;
    transactions.set(ref, { amount: 200000 });
    assert.strictEqual((await call("/api/wallet/topup/verify", { method: "POST", token: user.token, body: { reference: ref } })).status, 200);
    assert.strictEqual((await webhook({ reference: ref, amount: 200000, currency: "NGN", customer: {} })).status, 200);
    assert.strictEqual(await balanceOf(user.id), 2000);
    assert.strictEqual((await orderOf(ref)).status, "finalized");
  });

  await test("a booking is made by the webhook when the app never returns, and the app's own call then gets the same ride", async () => {
    const rider = await makeUser("hookride");
    const fare = await fareFor(rider);
    const init = await call("/api/payments/initialize", { method: "POST", token: rider.token, body: { email: rider.email, amountNaira: fare, purpose: "ride", booking: rideBody({}) } });
    const ref = init.body.reference;
    transactions.set(ref, { amount: fare * 100 });
    const data = { reference: ref, amount: fare * 100, currency: "NGN", customer: { email: rider.email } };
    assert.strictEqual((await webhook(data)).status, 200);
    let rides = await ridesFor(ref);
    assert.strictEqual(rides.length, 1);
    assert.strictEqual(rides[0].payment_status, "paid");
    assert.strictEqual(rides[0].rider_id, rider.id);
    assert.strictEqual((await orderOf(ref)).status, "finalized");
    assert.strictEqual((await orderOf(ref)).ride_id, rides[0].id);

    await webhook(data);
    assert.strictEqual((await ridesFor(ref)).length, 1, "a redelivery must not book a second ride");

    // An app that was only backgrounded now does what old builds always did.
    const old = await call("/api/rides", { method: "POST", token: rider.token, body: rideBody({ paymentMethod: "card", paymentReference: ref }) });
    assert.strictEqual(old.status, 200, JSON.stringify(old.body));
    assert.strictEqual(old.body.replayed, true);
    assert.strictEqual(old.body.ride.id, rides[0].id);
    assert.strictEqual((await ridesFor(ref)).length, 1);
  });

  await test("wrong amount: no ride, and the payment lands in the exceptions queue", async () => {
    const rider = await makeUser("hookshort");
    const fare = await fareFor(rider);
    const init = await call("/api/payments/initialize", { method: "POST", token: rider.token, body: { email: rider.email, amountNaira: fare, purpose: "ride", booking: rideBody({}) } });
    const ref = init.body.reference;
    transactions.set(ref, { amount: fare * 100 - 5000 });
    const r = await webhook({ reference: ref, amount: fare * 100 - 5000, currency: "NGN", customer: {} });
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await ridesFor(ref)).length, 0);
    const ex = await exceptionsOf(ref);
    assert.deepStrictEqual(ex.map((e) => e.reason), ["amount_mismatch"]);
    assert.strictEqual((await orderOf(ref)).status, "exception");
  });

  await test("a booking that no longer validates is not made, and is queued for a refund", async () => {
    const rider = await makeUser("hookbad");
    const fare = await fareFor(rider);
    const init = await call("/api/payments/initialize", { method: "POST", token: rider.token, body: { email: rider.email, amountNaira: fare, purpose: "ride", booking: rideBody({ vehicleType: "spaceship" }) } });
    const ref = init.body.reference;
    transactions.set(ref, { amount: fare * 100 });
    assert.strictEqual((await webhook({ reference: ref, amount: fare * 100, currency: "NGN", customer: {} })).status, 200);
    assert.strictEqual((await ridesFor(ref)).length, 0);
    const ex = await exceptionsOf(ref);
    assert.strictEqual(ex[0].reason, "ride_not_created");
    assert.strictEqual(ex[0].details.status, 400);
  });

  await test("a payment in another currency credits nothing and is queued", async () => {
    const user = await makeUser("hookusd");
    const init = await call("/api/payments/initialize", { method: "POST", token: user.token, body: { email: user.email, amountNaira: 5000, purpose: "wallet_topup" } });
    const ref = init.body.reference;
    assert.strictEqual((await webhook({ reference: ref, amount: 500000, currency: "USD", customer: {} })).status, 200);
    assert.strictEqual(await balanceOf(user.id), 0);
    assert.strictEqual((await exceptionsOf(ref))[0].reason, "wrong_currency");
  });

  await test("a failure that may pass on its own answers 5xx so Paystack retries, then clears itself", async () => {
    const user = await makeUser("hookdown");
    const init = await call("/api/payments/initialize", { method: "POST", token: user.token, body: { email: user.email, amountNaira: 4000, purpose: "wallet_topup" } });
    const ref = init.body.reference;
    const data = { reference: ref, amount: 400000, currency: "NGN", customer: {} };

    const realQuery = pool.query.bind(pool);
    let failures = 1;
    pool.query = (sql, params) => {
      if (failures > 0 && typeof sql === "string" && sql.includes("FROM rides WHERE payment_reference")) {
        failures--;
        return Promise.reject(new Error("database is down"));
      }
      return realQuery(sql, params);
    };
    let first;
    try {
      first = await webhook(data);
    } finally {
      delete pool.query;
    }
    assert.strictEqual(first.status, 500, "must not tell Paystack all is well");
    assert.strictEqual(await balanceOf(user.id), 0);
    assert.deepStrictEqual((await exceptionsOf(ref)).map((e) => [e.reason, e.status]), [["processing_error", "open"]]);

    assert.strictEqual((await webhook(data)).status, 200); // Paystack's retry
    assert.strictEqual(await balanceOf(user.id), 4000);
    assert.deepStrictEqual((await exceptionsOf(ref)).map((e) => [e.reason, e.status]), [["processing_error", "resolved"]]);
  });

  await test("signature and body rules still hold", async () => {
    assert.strictEqual((await webhook({ reference: "zzzz-1", amount: 1, currency: "NGN" }, { key: "wrong" })).status, 401);
    const raw = "{not json";
    const sig = crypto.createHmac("sha512", process.env.PAYSTACK_SECRET_KEY).update(raw).digest("hex");
    assert.strictEqual((await call("/api/payments/webhook", { method: "POST", body: raw, headers: { "x-paystack-signature": sig } })).status, 400);
    assert.strictEqual((await webhook({}, { event: "transfer.success" })).status, 200);
  });

  console.log("Old builds keep working (verify, then create the ride):");

  await test("webhook first, app second: one ride, and the sweep finds nothing wrong", async () => {
    const rider = await makeUser("legacy");
    const fare = await fareFor(rider);
    const ref = `legacy-${stamp}-1`;
    transactions.set(ref, { amount: fare * 100 });
    assert.strictEqual((await webhook({ reference: ref, amount: fare * 100, currency: "NGN", customer: {} })).status, 200);
    assert.strictEqual((await orderOf(ref)).status, "paid");
    assert.strictEqual((await ridesFor(ref)).length, 0, "an unlabelled payment must wait for the app");
    const made201 = await call("/api/rides", { method: "POST", token: rider.token, body: rideBody({ paymentMethod: "card", paymentReference: ref }) });
    assert.strictEqual(made201.status, 201, JSON.stringify(made201.body));
    await pool.query("UPDATE payment_orders SET paid_at = now() - interval '2 hours' WHERE reference = $1", [ref]);
    await sweepUnmatchedPayments();
    assert.strictEqual((await orderOf(ref)).status, "finalized");
    assert.deepStrictEqual(await exceptionsOf(ref), []);
  });

  await test("paid, app never came back, nothing claimed it: the sweep queues it after the grace period only", async () => {
    const lost = `lost-${stamp}-1`;
    const recent = `recent-${stamp}-1`;
    for (const ref of [lost, recent]) {
      assert.strictEqual((await webhook({ reference: ref, amount: 900000, currency: "NGN", customer: { email: "gone@example.com" } })).status, 200);
    }
    await pool.query("UPDATE payment_orders SET paid_at = now() - interval '45 minutes' WHERE reference = $1", [lost]);
    await sweepUnmatchedPayments();
    assert.deepStrictEqual((await exceptionsOf(lost)).map((e) => e.reason), ["paid_not_finalized"]);
    assert.deepStrictEqual(await exceptionsOf(recent), []);
    assert.strictEqual((await orderOf(recent)).status, "paid");
  });

  console.log("Refunds:");

  await test("admin can refund a queued payment once; support can read but not refund", async () => {
    const admin = await makeUser("refadmin", { role: "admin" });
    const support = await makeUser("refsupport", { role: "support" });
    const ref = `refund-${stamp}-1`;
    await webhook({ reference: ref, amount: 1200000, currency: "USD", customer: {} });
    const ex = (await exceptionsOf(ref))[0];

    const list = await call("/api/admin/payment-exceptions", { token: support.token });
    assert.strictEqual(list.status, 200);
    assert.ok(list.body.exceptions.some((e) => e.id === ex.id));
    assert.strictEqual((await call(`/api/admin/payment-exceptions/${ex.id}/refund`, { method: "POST", token: support.token, body: {} })).status, 403);
    assert.strictEqual((await call("/api/admin/payment-exceptions")).status, 401);

    const done = await call(`/api/admin/payment-exceptions/${ex.id}/refund`, { method: "POST", token: admin.token, body: {} });
    assert.strictEqual(done.status, 200, JSON.stringify(done.body));
    assert.strictEqual(done.body.exception.status, "refunded");
    assert.deepStrictEqual(refunds.filter((r) => r.transaction === ref), [{ transaction: ref, amount: 1200000 }]);
    assert.strictEqual((await call(`/api/admin/payment-exceptions/${ex.id}/refund`, { method: "POST", token: admin.token, body: {} })).status, 409);
    assert.strictEqual(refunds.filter((r) => r.transaction === ref).length, 1, "must never refund twice");
  });

  await test("a payment that already paid for something real cannot be refunded", async () => {
    const admin = await makeUser("refadmin2", { role: "admin" });
    const rider = await makeUser("refrider");
    const fare = await fareFor(rider);
    const ref = `spent-${stamp}-1`;
    transactions.set(ref, { amount: fare * 100 });
    assert.strictEqual((await call("/api/rides", { method: "POST", token: rider.token, body: rideBody({ paymentMethod: "card", paymentReference: ref }) })).status, 201);
    const { recordPaymentException } = require("../services/paymentOrders");
    const ex = await recordPaymentException(pool, { reference: ref, reason: "amount_mismatch", amountNaira: fare });
    const r = await call(`/api/admin/payment-exceptions/${ex.id}/refund`, { method: "POST", token: admin.token, body: {} });
    assert.strictEqual(r.status, 409, JSON.stringify(r.body));
    assert.strictEqual(refunds.filter((x) => x.transaction === ref).length, 0);
  });

  await test("a refused refund is marked failed and can be tried again; a partial refund is honoured", async () => {
    const admin = await makeUser("refadmin3", { role: "admin" });
    const ref = `refund-${stamp}-2`;
    await webhook({ reference: ref, amount: 800000, currency: "USD", customer: {} });
    const ex = (await exceptionsOf(ref))[0];
    failNextRefund = true;
    const bad = await call(`/api/admin/payment-exceptions/${ex.id}/refund`, { method: "POST", token: admin.token, body: {} });
    assert.strictEqual(bad.status, 502);
    assert.strictEqual((await exceptionsOf(ref))[0].status, "refund_failed");
    const tooMuch = await call(`/api/admin/payment-exceptions/${ex.id}/refund`, { method: "POST", token: admin.token, body: { amountNaira: 999999 } });
    assert.strictEqual(tooMuch.status, 400);
    const ok = await call(`/api/admin/payment-exceptions/${ex.id}/refund`, { method: "POST", token: admin.token, body: { amountNaira: 5000 } });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    assert.deepStrictEqual(refunds.filter((r) => r.transaction === ref), [{ transaction: ref, amount: 500000 }]);
  });

  console.log("Membership and wallet:");

  await test("two subscribe requests at once charge once, even when the wallet could pay twice", async () => {
    // 600000 covers two 250000 plans. With less, the second request would be
    // refused for lack of funds and this test would pass without proving the lock.
    const user = await makeUser("race", { wallet: 600000 });
    const [a, b] = await Promise.all([
      call("/api/memberships/subscribe", { method: "POST", token: user.token, body: { plan: "premium" } }),
      call("/api/memberships/subscribe", { method: "POST", token: user.token, body: { plan: "premium" } }),
    ]);
    assert.deepStrictEqual([a.status, b.status].sort(), [201, 400], JSON.stringify([a.body, b.body]));
    assert.strictEqual(await balanceOf(user.id), 350000);
    const n = await pool.query("SELECT count(*)::int n FROM memberships WHERE user_id = $1", [user.id]);
    assert.strictEqual(n.rows[0].n, 1);
    const tx = await pool.query("SELECT count(*)::int n FROM wallet_transactions WHERE user_id = $1 AND type = 'membership_charge'", [user.id]);
    assert.strictEqual(tx.rows[0].n, 1);
  });

  await test("a retry with the same idempotency key gets the first answer and no second charge", async () => {
    const user = await makeUser("idem", { wallet: 600000 });
    const key = `sub-${stamp}-a`;
    const first = await call("/api/memberships/subscribe", { method: "POST", token: user.token, body: { plan: "premium", idempotencyKey: key } });
    assert.strictEqual(first.status, 201);
    const again = await call("/api/memberships/subscribe", { method: "POST", token: user.token, body: { plan: "premium", idempotencyKey: key } });
    assert.strictEqual(again.status, 201);
    assert.strictEqual(again.body.membership.id, first.body.membership.id);
    assert.strictEqual(await balanceOf(user.id), 350000);
    const other = await call("/api/memberships/subscribe", { method: "POST", token: user.token, body: { plan: "executive", idempotencyKey: key } });
    assert.strictEqual(other.status, 409);
    const fresh = await call("/api/memberships/subscribe", { method: "POST", token: user.token, body: { plan: "premium", idempotencyKey: `sub-${stamp}-b` } });
    assert.strictEqual(fresh.status, 400, "a new key while a membership is active is still refused");
    assert.strictEqual(await balanceOf(user.id), 350000);
  });

  await test("old builds (no key) still subscribe, and a short wallet is refused without charge", async () => {
    const ok = await makeUser("nokey", { wallet: 250000 });
    assert.strictEqual((await call("/api/memberships/subscribe", { method: "POST", token: ok.token, body: { plan: "premium" } })).status, 201);
    assert.strictEqual(await balanceOf(ok.id), 0);
    const poor = await makeUser("poor", { wallet: 1000 });
    assert.strictEqual((await call("/api/memberships/subscribe", { method: "POST", token: poor.token, body: { plan: "premium" } })).status, 400);
    assert.strictEqual(await balanceOf(poor.id), 1000);
  });

  await test("the database itself refuses a negative wallet balance", async () => {
    const user = await makeUser("check", { wallet: 100 });
    await assert.rejects(
      pool.query("UPDATE users SET wallet_balance_naira = wallet_balance_naira - 101 WHERE id = $1", [user.id]),
      (e) => e.code === "23514"
    );
    assert.strictEqual(await balanceOf(user.id), 100);
  });

  // ── clean up ──
  for (const id of [...new Set(made)]) {
    await pool.query("DELETE FROM used_payment_references WHERE ride_id IN (SELECT id FROM rides WHERE rider_id = $1)", [id]).catch(() => {});
    await pool.query("DELETE FROM payment_orders WHERE user_id = $1", [id]).catch(() => {});
    await pool.query("DELETE FROM payment_exceptions WHERE user_id = $1", [id]).catch(() => {});
    await pool.query("DELETE FROM wallet_transactions WHERE user_id = $1", [id]).catch(() => {});
    await pool.query("DELETE FROM membership_idempotency_keys WHERE user_id = $1", [id]).catch(() => {});
    await pool.query("DELETE FROM memberships WHERE user_id = $1", [id]).catch(() => {});
    await pool.query("DELETE FROM ride_idempotency_keys WHERE user_id = $1", [id]).catch(() => {});
    await pool.query("DELETE FROM rides WHERE rider_id = $1", [id]).catch(() => {});
    await pool.query("DELETE FROM users WHERE id = $1", [id]).catch(() => {});
  }
  await pool.query("DELETE FROM used_payment_references WHERE reference LIKE $1", [`%-${stamp}-%`]).catch(() => {});
  await pool.query("DELETE FROM payment_orders WHERE reference LIKE $1", [`%-${stamp}-%`]).catch(() => {});
  await pool.query("DELETE FROM payment_exceptions WHERE reference LIKE $1", [`%-${stamp}-%`]).catch(() => {});

  axios.get = realGet;
  axios.post = realPost;
  server.close();
  await pool.end();
  console.log(`\n${passed} passed`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
