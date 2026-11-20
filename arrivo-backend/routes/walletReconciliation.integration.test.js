// Run: DATABASE_URL=postgres://...@localhost:... node routes/walletReconciliation.integration.test.js
// The daily balance check and top-up routing against a real database.
const assert = require("assert");
const http = require("http");
const jwt = require("jsonwebtoken");
const axios = require("axios");

process.env.JWT_SECRET = process.env.JWT_SECRET || "integration-test-secret";
process.env.PAYSTACK_SECRET_KEY = "sk_test_unit";
process.env.WALLET_RECON_HOUR_LAGOS = "0";

const express = require("express");
require("express-async-errors");
const { pool } = require("../db/db");
const recon = require("../services/walletReconciliation");
const holds = require("../services/walletHolds");
const { creditWalletTopup } = require("../services/walletTopup");

let passed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.log(`FAIL  ${name}\n      ${e.stack || e.message}`); process.exitCode = 1; }
}

const app = express();
app.use(express.json());
app.use("/api/admin/wallet-settlements", require("./adminWalletSettlement"));
app.use((err, req, res, next) => res.status(500).json({ error: "server error", detail: err.message }));
const server = http.createServer(app);
async function admin(method, path, token, body) {
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const tag = Date.now();
async function mkUser(role, balance) {
  const r = await pool.query(
    `INSERT INTO users (name, email, password_hash, role, email_verified, wallet_balance_naira) VALUES ($1, $2, 'x', $3, true, $4) RETURNING id, email`,
    [`R ${role}`, `recon-${role}-${tag}-${Math.random().toString(36).slice(2, 7)}@example.test`, role, balance]
  );
  return r.rows[0];
}
const tok = (u, role) => jwt.sign({ id: u.id, email: u.email, role }, process.env.JWT_SECRET);

(async () => {
  await new Promise((r) => server.listen(0, r));
  const adminU = await mkUser("admin", 0);
  const riderU = await mkUser("rider", 0);
  const driverU = await mkUser("driver", 0);
  const A = tok(adminU, "admin");

  await test("expected holding balance = rider balances + held + spent-not-settled; drivers are reported apart", async () => {
    const before = await recon.computeLive();
    await pool.query("UPDATE users SET wallet_balance_naira = 5000 WHERE id = $1", [riderU.id]);
    await pool.query("UPDATE users SET wallet_balance_naira = 700 WHERE id = $1", [driverU.id]);
    let now = await recon.computeLive();
    assert.strictEqual(now.expectedNaira - before.expectedNaira, 5000);
    assert.strictEqual(now.driverWalletsNaira - before.driverWalletsNaira, 700);
    await holds.placeHold({ service: "express", userId: riderU.id, amountNaira: 2000, idempotencyKey: `recon-a-${tag}`, externalRef: `recon-trip-a-${tag}` });
    now = await recon.computeLive();
    assert.strictEqual(now.expectedNaira - before.expectedNaira, 5000, "moving money into a hold changes nothing");
    assert.strictEqual(now.heldNaira - before.heldNaira, 2000);
    await holds.capture({ service: "express", externalRef: `recon-trip-a-${tag}`, amountNaira: 1500 });
    now = await recon.computeLive();
    assert.strictEqual(now.expectedNaira - before.expectedNaira, 5000, "a trip being charged moves money between parts, the total stays");
    assert.strictEqual(now.unsettledNaira - before.unsettledNaira, 1500);
  });

  await test("a settlement approved by a second admin takes the money out of the expected balance", async () => {
    const before = await recon.computeLive();
    const second = await mkUser("admin", 0);
    const S = require("../services/walletSettlement");
    const made = await S.create({ service: "express", adminId: adminU.id });
    assert.strictEqual((await recon.computeLive()).expectedNaira, before.expectedNaira, "a pending settlement has not moved money yet");
    await S.approve({ id: made.id, adminId: second.id, bankReference: "BANK-REF-RECON-1" });
    assert.strictEqual(before.expectedNaira - (await recon.computeLive()).expectedNaira, made.amountNaira);
  });

  await test("bank balance: equal is fine, short is a mismatch with the exact difference, bad input refused", async () => {
    const live = await recon.computeLive();
    const ok = await admin("POST", "/api/admin/wallet-settlements/reconciliation/bank-balance", A, { bankBalanceNaira: live.expectedNaira });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.body.differenceNaira, 0);
    assert.notStrictEqual(ok.body.status, "mismatch");
    const short = await admin("POST", "/api/admin/wallet-settlements/reconciliation/bank-balance", A, { bankBalanceNaira: live.expectedNaira - 500, note: "short" });
    assert.strictEqual(short.body.status, "mismatch");
    assert.strictEqual(short.body.differenceNaira, -500);
    assert.ok(short.body.findings.some((f) => f.code === "bank_mismatch"));
    assert.strictEqual((await admin("POST", "/api/admin/wallet-settlements/reconciliation/bank-balance", A, { bankBalanceNaira: -1 })).body.code, "BAD_BALANCE");
    assert.strictEqual((await admin("POST", "/api/admin/wallet-settlements/reconciliation/bank-balance", A, { bankBalanceNaira: "x" })).body.code, "BAD_BALANCE");
  });

  await test("a rider balance with no ledger behind it is flagged", async () => {
    const f = await recon.integrityFindings();
    const drift = f.find((x) => x.code === "ledger_drift");
    assert.ok(drift, "ledger_drift raised");
    assert.ok(drift.sample.some((s) => s.userId === riderU.id));
  });

  await test("stale holds and overdue settlements are flagged", async () => {
    await holds.placeHold({ service: "express", userId: riderU.id, amountNaira: 100, idempotencyKey: `recon-b-${tag}`, externalRef: `recon-trip-b-${tag}` });
    await pool.query("UPDATE wallet_holds SET expires_at = now() - interval '3 hours' WHERE external_ref = $1", [`recon-trip-b-${tag}`]);
    await holds.placeHold({ service: "express", userId: riderU.id, amountNaira: 200, idempotencyKey: `recon-c-${tag}`, externalRef: `recon-trip-c-${tag}` });
    await holds.capture({ service: "express", externalRef: `recon-trip-c-${tag}` });
    await pool.query("UPDATE wallet_holds SET captured_at = now() - interval '30 days' WHERE external_ref = $1", [`recon-trip-c-${tag}`]);
    const f = await recon.integrityFindings();
    assert.ok(f.some((x) => x.code === "stale_holds"));
    assert.ok(f.some((x) => x.code === "settlement_overdue" && x.service === "express"));
    await holds.expireStale();
  });

  await test("top-ups remember where the money went; a server started order is 'holding', anything else 'direct'", async () => {
    const a = `rt-hold-${tag}`, b = `rt-direct-${tag}`;
    await pool.query("INSERT INTO payment_orders (reference, user_id, purpose, amount_naira, funds_route) VALUES ($1, $2, 'wallet_topup', 1000, 'holding')", [a, riderU.id]);
    const c1 = await pool.connect();
    try {
      await c1.query("BEGIN");
      assert.strictEqual((await creditWalletTopup(c1, { userId: riderU.id, reference: a, amountNaira: 1000 })).credited, true);
      assert.strictEqual((await creditWalletTopup(c1, { userId: riderU.id, reference: b, amountNaira: 300 })).credited, true);
      await c1.query("COMMIT");
    } finally { c1.release(); }
    const rows = await pool.query("SELECT paystack_reference r, funding_route f FROM wallet_transactions WHERE paystack_reference = ANY($1)", [[a, b]]);
    assert.strictEqual(rows.rows.find((x) => x.r === a).f, "holding");
    assert.strictEqual(rows.rows.find((x) => x.r === b).f, "direct");
    const f = await recon.integrityFindings();
    const d = f.find((x) => x.code === "topups_not_in_holding");
    assert.ok(d && d.naira >= 300, "the direct top-up shows as money to move");
  });

  await test("with enforcement on, a top-up that did not go to the holding account is refused and nothing is credited", async () => {
    process.env.PAYSTACK_WALLET_SUBACCOUNT = "ACCT_testsub";
    process.env.WALLET_TOPUP_REQUIRE_HOLDING = "true";
    try {
      const before = Number((await pool.query("SELECT wallet_balance_naira b FROM users WHERE id = $1", [riderU.id])).rows[0].b);
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        const r = await creditWalletTopup(c, { userId: riderU.id, reference: `rt-refuse-${tag}`, amountNaira: 999 });
        await c.query("COMMIT");
        assert.strictEqual(r.credited, false);
        assert.strictEqual(r.reason, "not_in_holding");
      } finally { c.release(); }
      assert.strictEqual(Number((await pool.query("SELECT wallet_balance_naira b FROM users WHERE id = $1", [riderU.id])).rows[0].b), before);
      const used = await pool.query("SELECT 1 FROM used_payment_references WHERE reference = $1", [`rt-refuse-${tag}`]);
      assert.strictEqual(used.rows.length, 0, "the reference stays free");
    } finally { delete process.env.PAYSTACK_WALLET_SUBACCOUNT; delete process.env.WALLET_TOPUP_REQUIRE_HOLDING; }
  });

  await test("Paystack is started with the holding subaccount and the main account bears the fee, only when asked", async () => {
    const { initializePaystackTransaction } = require("./payments");
    const seen = [];
    const post = axios.post;
    axios.post = async (url, body) => { seen.push(body); return { data: { data: { authorization_url: "u", access_code: "a", reference: "r" } } }; };
    try {
      await initializePaystackTransaction({ email: "a@b.co", amountNaira: 20000, subaccount: "ACCT_testsub" });
      await initializePaystackTransaction({ email: "a@b.co", amountNaira: 20000 });
    } finally { axios.post = post; }
    assert.strictEqual(seen[0].subaccount, "ACCT_testsub");
    assert.strictEqual(seen[0].bearer, "account");
    assert.strictEqual(seen[0].amount, 2000000);
    assert.strictEqual(seen[1].subaccount, undefined);
    assert.strictEqual(seen[1].bearer, undefined);
  });

  await test("the daily job writes one snapshot per Lagos day, and says when no bank balance was recorded", async () => {
    await pool.query("DELETE FROM wallet_reconciliations WHERE kind = 'snapshot' AND lagos_day = (now() AT TIME ZONE 'Africa/Lagos')::date");
    await pool.query("DELETE FROM wallet_reconciliations WHERE kind = 'bank' AND lagos_day = (now() AT TIME ZONE 'Africa/Lagos')::date");
    const first = await recon.runDaily();
    assert.strictEqual(first.ran, true);
    assert.strictEqual((await recon.runDaily()).reason, "done_today");
    const snap = (await pool.query("SELECT * FROM wallet_reconciliations WHERE kind = 'snapshot' ORDER BY id DESC LIMIT 1")).rows[0];
    assert.ok(snap.findings.some((f) => f.code === "bank_balance_not_recorded"));
    process.env.WALLET_RECON_HOUR_LAGOS = "23";
    const hour = Number((await pool.query("SELECT EXTRACT(hour FROM now() AT TIME ZONE 'Africa/Lagos') h")).rows[0].h);
    if (hour < 23) {
      await pool.query("DELETE FROM wallet_reconciliations WHERE kind = 'snapshot' AND lagos_day = (now() AT TIME ZONE 'Africa/Lagos')::date");
      assert.strictEqual((await recon.runDaily()).reason, "too_early");
    }
    process.env.WALLET_RECON_HOUR_LAGOS = "0";
  });

  await test("only admins can see or record the check", async () => {
    const R = tok(riderU, "rider");
    assert.strictEqual((await admin("GET", "/api/admin/wallet-settlements/reconciliation", R)).status, 403);
    assert.strictEqual((await admin("POST", "/api/admin/wallet-settlements/reconciliation/bank-balance", R, { bankBalanceNaira: 1 })).status, 403);
    const o = await admin("GET", "/api/admin/wallet-settlements/reconciliation", A);
    assert.strictEqual(o.status, 200);
    assert.strictEqual(typeof o.body.live.expectedNaira, "number");
    assert.ok(Array.isArray(o.body.history));
  });

  console.log(`\n${passed} passed`);
  server.close();
  await pool.end();
})();
