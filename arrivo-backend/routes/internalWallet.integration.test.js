// Run: DATABASE_URL=postgres://...@localhost:... node routes/internalWallet.integration.test.js
// The shared wallet (holds, signed service API, settlements) against a real database.
const assert = require("assert");
const http = require("http");
const jwt = require("jsonwebtoken");

process.env.JWT_SECRET = process.env.JWT_SECRET || "integration-test-secret";
const SECRET = "x".repeat(40);
process.env.WALLET_SERVICE_SECRET_EXPRESS = SECRET;

const express = require("express");
require("express-async-errors");
const { pool } = require("../db/db");
const { sign } = require("../services/walletServiceAuth");
const holds = require("../services/walletHolds");

let passed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.log(`FAIL  ${name}\n      ${e.stack || e.message}`); process.exitCode = 1; }
}

const app = express();
app.use((req, res, next) => (req.originalUrl.startsWith("/api/internal/wallet") ? next() : express.json()(req, res, next)));
app.use("/api/internal/wallet", require("./internalWallet"));
app.use("/api/admin/wallet-settlements", require("./adminWalletSettlement"));
app.use((err, req, res, next) => res.status(500).json({ error: "server error", detail: err.message }));
const server = http.createServer(app);

async function signed(method, path, body, opts = {}) {
  const { port } = server.address();
  const raw = body === undefined ? "" : JSON.stringify(body);
  const timestamp = String(opts.timestamp || Math.floor(Date.now() / 1000));
  const signature = sign({ secret: opts.secret || SECRET, timestamp, method, path, rawBody: raw });
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { "content-type": "application/json", "x-service": opts.service || "express", "x-timestamp": timestamp, "x-signature": opts.badSig ? "00" + signature.slice(2) : signature },
    body: raw || undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
async function admin(method, path, token, body) {
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const tag = Date.now();
async function mkUser(role, balance, verified = true) {
  const r = await pool.query(
    `INSERT INTO users (name, email, password_hash, role, email_verified, wallet_balance_naira)
     VALUES ($1, $2, 'x', $3, $4, $5) RETURNING id, email`,
    [`T ${role}`, `wallet-${role}-${tag}-${Math.random().toString(36).slice(2, 7)}@example.test`, role, verified, balance]
  );
  return r.rows[0];
}
const balanceOf = async (id) => Number((await pool.query("SELECT wallet_balance_naira FROM users WHERE id=$1", [id])).rows[0].wallet_balance_naira);

(async () => {
  await new Promise((r) => server.listen(0, r));
  const rider = await mkUser("rider", 10000);
  const unverified = await mkUser("rider", 5000, false);
  const adminA = await mkUser("admin", 0);
  const adminB = await mkUser("admin", 0);
  const tokenA = jwt.sign({ id: adminA.id, email: adminA.email, role: "admin" }, process.env.JWT_SECRET);
  const tokenB = jwt.sign({ id: adminB.id, email: adminB.email, role: "admin" }, process.env.JWT_SECRET);
  const ref = (n) => `trip-${tag}-${n}`;
  const hold = (n, amt, extra = {}) => signed("POST", "/api/internal/wallet/holds", { riderUserId: rider.id, amountNaira: amt, idempotencyKey: `idem-${tag}-${n}`, externalRef: ref(n), ...extra });

  await test("unsigned, wrongly signed, stale and unknown-service calls are refused", async () => {
    const { port } = server.address();
    assert.strictEqual((await fetch(`http://127.0.0.1:${port}/api/internal/wallet/resolve`, { method: "POST" })).status, 401);
    assert.strictEqual((await signed("POST", "/api/internal/wallet/resolve", { email: rider.email }, { badSig: true })).status, 401);
    assert.strictEqual((await signed("POST", "/api/internal/wallet/resolve", { email: rider.email }, { timestamp: Math.floor(Date.now() / 1000) - 3600 })).status, 401);
    assert.strictEqual((await signed("POST", "/api/internal/wallet/resolve", { email: rider.email }, { service: "mystery" })).status, 401);
    assert.strictEqual((await signed("POST", "/api/internal/wallet/resolve", { email: rider.email }, { secret: "y".repeat(40) })).status, 401);
  });

  await test("resolve finds a verified rider and refuses an unverified one", async () => {
    const ok = await signed("POST", "/api/internal/wallet/resolve", { email: rider.email.toUpperCase() });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.body.userId, rider.id);
    assert.strictEqual(ok.body.balanceNaira, 10000);
    assert.strictEqual((await signed("POST", "/api/internal/wallet/resolve", { email: unverified.email })).body.code, "EMAIL_NOT_VERIFIED");
    assert.strictEqual((await signed("POST", "/api/internal/wallet/resolve", { email: "nobody@example.test" })).status, 404);
  });

  await test("a hold debits at once, tags the ledger, and a retry does not hold twice", async () => {
    const a = await hold(1, 3000);
    assert.strictEqual(a.status, 200);
    assert.strictEqual(a.body.balanceNaira, 7000);
    const b = await hold(1, 3000);
    assert.strictEqual(b.status, 200);
    assert.strictEqual(b.body.replay, true);
    assert.strictEqual(await balanceOf(rider.id), 7000);
    const tx = await pool.query("SELECT service, amount_naira FROM wallet_transactions WHERE user_id=$1 AND type='hold'", [rider.id]);
    assert.strictEqual(tx.rows.length, 1);
    assert.strictEqual(tx.rows[0].service, "express");
    assert.strictEqual(Number(tx.rows[0].amount_naira), -3000);
  });

  await test("reusing a key or trip for a different hold is a conflict", async () => {
    assert.strictEqual((await hold(1, 4000)).body.code, "KEY_CONFLICT");
    assert.strictEqual((await hold(9, 100, { externalRef: ref(1) })).body.code, "KEY_CONFLICT");
    assert.strictEqual(await balanceOf(rider.id), 7000);
  });

  await test("low balance is refused with 402 and nothing moves", async () => {
    const r = await hold(2, 999999);
    assert.strictEqual(r.status, 402);
    assert.strictEqual(r.body.code, "INSUFFICIENT_BALANCE");
    assert.strictEqual(await balanceOf(rider.id), 7000);
  });

  await test("bad amounts are refused", async () => {
    for (const bad of [0, -5, 12.5, "abc", 99999999]) assert.strictEqual((await hold(3, bad)).status, 400);
  });

  await test("two identical simultaneous holds take the money once", async () => {
    const [x, y] = await Promise.all([hold(4, 1000), hold(4, 1000)]);
    assert.deepStrictEqual([x.status, y.status], [200, 200]);
    assert.strictEqual(await balanceOf(rider.id), 6000);
  });

  await test("capture keeps the money, is idempotent, and then cannot be released", async () => {
    const c = await signed("POST", `/api/internal/wallet/holds/${ref(1)}/capture`, {});
    assert.strictEqual(c.status, 200);
    assert.strictEqual(c.body.status, "captured");
    assert.strictEqual(c.body.capturedNaira, 3000);
    assert.strictEqual((await signed("POST", `/api/internal/wallet/holds/${ref(1)}/capture`, {})).body.replay, true);
    assert.strictEqual((await signed("POST", `/api/internal/wallet/holds/${ref(1)}/release`, {})).body.code, "ALREADY_CAPTURED");
    assert.strictEqual(await balanceOf(rider.id), 6000);
  });

  await test("a smaller final charge returns the difference; a bigger one is refused", async () => {
    const c = await signed("POST", `/api/internal/wallet/holds/${ref(4)}/capture`, { amountNaira: 600 });
    assert.strictEqual(c.body.capturedNaira, 600);
    assert.strictEqual(await balanceOf(rider.id), 6400);
    await hold(5, 500);
    assert.strictEqual((await signed("POST", `/api/internal/wallet/holds/${ref(5)}/capture`, { amountNaira: 501 })).body.code, "BAD_AMOUNT");
  });

  await test("release returns everything, once, and cannot then be captured", async () => {
    assert.strictEqual(await balanceOf(rider.id), 5900);
    const r = await signed("POST", `/api/internal/wallet/holds/${ref(5)}/release`, {});
    assert.strictEqual(r.body.status, "released");
    assert.strictEqual(await balanceOf(rider.id), 6400);
    assert.strictEqual((await signed("POST", `/api/internal/wallet/holds/${ref(5)}/release`, {})).body.replay, true);
    assert.strictEqual(await balanceOf(rider.id), 6400);
    assert.strictEqual((await signed("POST", `/api/internal/wallet/holds/${ref(5)}/capture`, {})).body.code, "ALREADY_RELEASED");
  });

  await test("an unknown trip is a 404", async () => {
    assert.strictEqual((await signed("GET", `/api/internal/wallet/holds/${ref(77)}`)).status, 404);
  });

  await test("expiry sweep releases an open hold past its time and leaves live ones", async () => {
    await hold(6, 400);
    await hold(7, 300);
    await pool.query("UPDATE wallet_holds SET expires_at = now() - interval '1 minute' WHERE external_ref = $1", [ref(6)]);
    const before = await balanceOf(rider.id);
    assert.ok((await holds.expireStale()) >= 1);
    assert.strictEqual(await balanceOf(rider.id), before + 400);
    assert.strictEqual((await signed("GET", `/api/internal/wallet/holds/${ref(6)}`)).body.status, "released");
    assert.strictEqual((await signed("GET", `/api/internal/wallet/holds/${ref(7)}`)).body.status, "held");
  });

  await test("settlement: maker cannot approve own, checker can, trips cannot be settled twice", async () => {
    const rep = await admin("GET", "/api/admin/wallet-settlements/report", tokenA);
    assert.strictEqual(rep.status, 200);
    const exp = rep.body.services.find((s) => s.service === "express");
    assert.ok(exp.unsettledNaira >= 3600);
    const made = await admin("POST", "/api/admin/wallet-settlements", tokenA, { service: "express" });
    assert.strictEqual(made.status, 200, JSON.stringify(made.body));
    assert.strictEqual((await admin("POST", "/api/admin/wallet-settlements", tokenA, { service: "express" })).body.code, "NOTHING_TO_SETTLE");
    const id = made.body.id;
    assert.strictEqual((await admin("POST", `/api/admin/wallet-settlements/${id}/approve`, tokenA, { bankReference: "BANK-REF-1" })).body.code, "SAME_PERSON");
    assert.strictEqual((await admin("POST", `/api/admin/wallet-settlements/${id}/approve`, tokenB, {})).body.code, "BAD_REFERENCE");
    const ok = await admin("POST", `/api/admin/wallet-settlements/${id}/approve`, tokenB, { bankReference: "BANK-REF-1" });
    assert.strictEqual(ok.body.status, "approved");
    assert.strictEqual((await admin("POST", `/api/admin/wallet-settlements/${id}/cancel`, tokenA)).body.code, "NOT_PENDING");
  });

  await test("cancelling a pending settlement frees its trips; riders and non-admins cannot reach it", async () => {
    await hold(8, 200);
    await signed("POST", `/api/internal/wallet/holds/${ref(8)}/capture`, {});
    const made = await admin("POST", "/api/admin/wallet-settlements", tokenA, { service: "express" });
    assert.strictEqual(made.status, 200);
    assert.strictEqual((await admin("POST", `/api/admin/wallet-settlements/${made.body.id}/cancel`, tokenB)).body.status, "cancelled");
    const again = await admin("POST", "/api/admin/wallet-settlements", tokenB, { service: "express" });
    assert.strictEqual(again.status, 200);
    const riderToken = jwt.sign({ id: rider.id, email: rider.email, role: "rider" }, process.env.JWT_SECRET);
    assert.strictEqual((await admin("GET", "/api/admin/wallet-settlements/report", riderToken)).status, 403);
    assert.strictEqual((await admin("POST", "/api/admin/wallet-settlements", tokenA, { service: "nope" })).body.code, "BAD_SERVICE");
  });

  await test("payout float answers with numbers", async () => {
    const f = await admin("GET", "/api/admin/wallet-settlements/payout-float", tokenA);
    assert.strictEqual(f.status, 200);
    assert.strictEqual(typeof f.body.recommendedFloatNaira, "number");
  });

  await test("the ledger always matches the balance", async () => {
    const sum = await pool.query("SELECT COALESCE(SUM(amount_naira),0) s FROM wallet_transactions WHERE user_id=$1", [rider.id]);
    assert.strictEqual(Number(sum.rows[0].s) + 10000, await balanceOf(rider.id));
  });

  console.log(`\n${passed} passed`);
  server.close();
  await pool.end();
})();
