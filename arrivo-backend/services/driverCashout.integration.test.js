// Against a REAL Postgres, with Paystack replaced by a fake: driver cash-out.
// What only a real database proves: the wallet is debited once however many
// requests race, a failed transfer returns the money exactly once, and a
// timeout never refunds on a guess.

const assert = require("assert");
const http = require("http");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");

process.env.JWT_SECRET = process.env.JWT_SECRET || "integration-test-secret";
process.env.PAYSTACK_SECRET_KEY = "sk_test_cashout";
process.env.CASHOUT_DAILY_MAX_NAIRA = "60000";
process.env.CASHOUT_REVIEW_ABOVE_NAIRA = "30000";
process.env.CASHOUT_MAX_NAIRA = "100000";

const express = require("express");
require("express-async-errors");
const { pool, ready } = require("../db/db");
const cashout = require("./driverCashout");
const systemConfig = require("./systemConfig");
const paystackTransfers = require("./paystackTransfers");
const { PaystackError } = paystackTransfers;

let passed = 0;
const test = (name, fn) => (async () => {
  try { await fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.log(`FAIL  ${name}\n      ${e.stack || e.message}`); process.exitCode = 1; }
})();

// ── Fake Paystack ───────────────────────────────────────────────────────
const fake = {
  banks: [{ code: "058", name: "GTBank" }, { code: "044", name: "Access Bank" }],
  accounts: {}, transfers: {}, initiated: [],
  nextInitiate: null, // a function or null
  resolveError: null,
  async listBanks() { return this.banks; },
  async resolveAccount(num) {
    if (this.resolveError) throw this.resolveError;
    if (!this.accounts[num]) throw new PaystackError("Could not resolve account name", { status: 422 });
    return { accountName: this.accounts[num], accountNumber: num };
  },
  async createRecipient({ accountNumber }) { return { recipientCode: `RCP_${accountNumber}` }; },
  async initiateTransfer(args) {
    this.initiated.push(args);
    if (this.nextInitiate) { const f = this.nextInitiate; this.nextInitiate = null; return f(args); }
    if (this.transfers[args.reference]) throw new PaystackError("Transfer with this reference already exists", { status: 400 });
    this.transfers[args.reference] = { status: "pending", code: `TRF_${args.reference}` };
    return { status: "pending", transferCode: `TRF_${args.reference}` };
  },
  async verifyTransfer(reference) {
    const t = this.transfers[reference];
    if (!t) throw new PaystackError("Transfer not found", { status: 404 });
    return { status: t.status, transferCode: t.code };
  },
};
paystackTransfers._setClient(fake);

// ── App ─────────────────────────────────────────────────────────────────
const app = express();
app.use("/api/payments", require("../routes/payments")); // webhook needs the raw body
app.use(express.json());
app.use("/api/cashout", require("../routes/driverCashout"));
app.use("/api/admin/cashouts", require("../routes/adminCashouts"));
app.use((err, req, res, next) => res.status(500).json({ error: "server error", detail: err.message }));
const server = http.createServer(app);
async function call(method, path, token, body) {
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
async function webhook(event, data, sign = true) {
  const { port } = server.address();
  const raw = JSON.stringify({ event, data });
  const sig = crypto.createHmac("sha512", sign ? process.env.PAYSTACK_SECRET_KEY : "wrong").update(raw).digest("hex");
  const res = await fetch(`http://127.0.0.1:${port}/api/payments/webhook`, { method: "POST", headers: { "Content-Type": "application/json", "x-paystack-signature": sig }, body: raw });
  return res.status;
}

const created = { users: [] };
async function makeUser(role, name) {
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const r = await pool.query(
    `INSERT INTO users (name, email, password_hash, role, agreed_to_terms, wallet_balance_naira) VALUES ($1,$2,'x',$3,true,0) RETURNING *`,
    [name, `co-${stamp}@example.com`, role]);
  created.users.push(r.rows[0].id);
  return r.rows[0];
}
const tokenFor = (u) => jwt.sign({ id: u.id, email: u.email, role: u.role }, process.env.JWT_SECRET);
const balance = async (u) => Number((await pool.query("SELECT wallet_balance_naira AS b FROM users WHERE id=$1", [u.id])).rows[0].b);
// Give a driver wallet money of a given kind ('credit' = earned, 'topup' = card money).
async function fund(u, amount, type = "credit") {
  const bal = await pool.query("UPDATE users SET wallet_balance_naira = wallet_balance_naira + $1 WHERE id=$2 RETURNING wallet_balance_naira", [amount, u.id]);
  await pool.query(`INSERT INTO wallet_transactions (user_id,type,status,amount_naira,balance_after_naira,description) VALUES ($1,$2,'completed',$3,$4,'test')`, [u.id, type, amount, bal.rows[0].wallet_balance_naira]);
}
// A driver with a verified bank account that is old enough to withdraw.
async function readyDriver(name = "Biola Lawal", earned = 50000) {
  const u = await makeUser("driver", name);
  fake.accounts["0123456789"] = "LAWAL BIOLA SHERIFF";
  await cashout.saveBankAccount(u.id, { bankCode: "058", accountNumber: "0123456789" });
  await pool.query("UPDATE driver_bank_accounts SET changed_at = now() - interval '3 days' WHERE user_id = $1", [u.id]);
  if (earned) await fund(u, earned);
  return u;
}
const row = async (id) => (await pool.query("SELECT * FROM wallet_withdrawals WHERE id=$1", [id])).rows[0];
const setSwitch = (on) => systemConfig.setConfig("driver_cashout_enabled", on ? "true" : "false", null);

(async () => {
  await ready;
  await new Promise((r) => server.listen(0, r));
  await pool.query("DELETE FROM wallet_withdrawals");
  await pool.query("DELETE FROM system_config WHERE key = 'driver_cashout_enabled'");
  const admin = await makeUser("admin", "Cash Admin");
  const adminToken = tokenFor(admin);

  await test("cash-out is off until the switch is turned on", async () => {
    const d = await readyDriver();
    await assert.rejects(() => cashout.requestCashout(d.id, { amountNaira: 5000 }), (e) => e.code === "CASHOUT_DISABLED");
    assert.strictEqual(await balance(d), 50000);
  });

  await setSwitch(true);

  await test("a bank account in someone else's name is refused", async () => {
    const d = await makeUser("driver", "Chidi Okafor");
    fake.accounts["0123456789"] = "LAWAL BIOLA SHERIFF";
    await assert.rejects(() => cashout.saveBankAccount(d.id, { bankCode: "058", accountNumber: "0123456789" }), (e) => e.code === "NAME_MISMATCH");
  });

  await test("bad account numbers, unknown banks and unresolvable accounts are refused", async () => {
    const d = await makeUser("driver", "Biola Lawal");
    await assert.rejects(() => cashout.saveBankAccount(d.id, { bankCode: "058", accountNumber: "123" }), (e) => e.code === "INVALID_ACCOUNT_NUMBER");
    await assert.rejects(() => cashout.saveBankAccount(d.id, { bankCode: "999", accountNumber: "0123456789" }), (e) => e.code === "UNKNOWN_BANK");
    await assert.rejects(() => cashout.saveBankAccount(d.id, { bankCode: "058", accountNumber: "0000000000" }), (e) => e.code === "ACCOUNT_NOT_FOUND");
    fake.resolveError = new PaystackError("boom", { network: true });
    await assert.rejects(() => cashout.saveBankAccount(d.id, { bankCode: "058", accountNumber: "0123456789" }), (e) => e.code === "BANK_LOOKUP_UNAVAILABLE");
    fake.resolveError = null;
  });

  await test("a new bank account blocks cash-out during the cooling-off period", async () => {
    const d = await makeUser("driver", "Biola Lawal");
    fake.accounts["0123456789"] = "LAWAL BIOLA SHERIFF";
    await cashout.saveBankAccount(d.id, { bankCode: "058", accountNumber: "0123456789" });
    await fund(d, 20000);
    await assert.rejects(() => cashout.requestCashout(d.id, { amountNaira: 5000 }), (e) => e.code === "BANK_COOLING_OFF");
    assert.strictEqual(await balance(d), 20000);
  });

  await test("no bank account means no cash-out", async () => {
    const d = await makeUser("driver", "Biola Lawal");
    await fund(d, 20000);
    await assert.rejects(() => cashout.requestCashout(d.id, { amountNaira: 5000 }), (e) => e.code === "NO_BANK_ACCOUNT");
  });

  await test("card top-up money cannot be withdrawn, only earnings", async () => {
    const d = await readyDriver("Biola Lawal", 0);
    await fund(d, 40000, "topup");
    await assert.rejects(() => cashout.requestCashout(d.id, { amountNaira: 5000 }), (e) => e.code === "INSUFFICIENT_WITHDRAWABLE");
    await fund(d, 3000, "credit");
    await assert.rejects(() => cashout.requestCashout(d.id, { amountNaira: 5000 }), (e) => e.code === "INSUFFICIENT_WITHDRAWABLE");
    const ok = await cashout.requestCashout(d.id, { amountNaira: 3000 });
    assert.ok(ok.id);
    assert.strictEqual(await balance(d), 40000);
  });

  let d1, w1;
  await test("a cash-out debits the wallet, writes the ledger and is sent to Paystack with our reference", async () => {
    d1 = await readyDriver();
    const out = await cashout.requestCashout(d1.id, { amountNaira: 10000 });
    assert.strictEqual(out.status, "processing");
    w1 = await row(out.id);
    assert.strictEqual(await balance(d1), 40000);
    assert.strictEqual(fake.initiated.at(-1).reference, w1.reference);
    assert.strictEqual(fake.initiated.at(-1).amountNaira, 10000);
    assert.strictEqual(fake.initiated.at(-1).recipientCode, "RCP_0123456789");
    const tx = (await pool.query("SELECT * FROM wallet_transactions WHERE id=$1", [w1.debit_transaction_id])).rows[0];
    assert.strictEqual(tx.type, "withdrawal");
    assert.strictEqual(Number(tx.amount_naira), -10000);
    assert.strictEqual(w1.account_last4, "6789");
  });

  await test("a webhook with a bad signature is rejected and changes nothing", async () => {
    assert.strictEqual(await webhook("transfer.success", { reference: w1.reference }, false), 401);
    assert.strictEqual((await row(w1.id)).status, "processing");
  });

  await test("transfer.success marks it paid, and a repeated webhook changes nothing", async () => {
    assert.strictEqual(await webhook("transfer.success", { reference: w1.reference, transfer_code: "TRF_x" }), 200);
    assert.strictEqual((await row(w1.id)).status, "paid");
    assert.strictEqual(await webhook("transfer.success", { reference: w1.reference }), 200);
    assert.strictEqual(await balance(d1), 40000);
  });

  await test("a reversal after success returns the money exactly once", async () => {
    assert.strictEqual(await webhook("transfer.reversed", { reference: w1.reference }), 200);
    assert.strictEqual((await row(w1.id)).status, "reversed");
    assert.strictEqual(await balance(d1), 50000);
    await webhook("transfer.reversed", { reference: w1.reference });
    await webhook("transfer.failed", { reference: w1.reference });
    assert.strictEqual(await balance(d1), 50000);
    const refunds = (await pool.query("SELECT count(*)::int AS n FROM wallet_transactions WHERE user_id=$1 AND type='withdrawal_reversal'", [d1.id])).rows[0].n;
    assert.strictEqual(refunds, 1);
  });

  await test("transfer.failed returns the money, once, and the money can be withdrawn again", async () => {
    const d = await readyDriver();
    const out = await cashout.requestCashout(d.id, { amountNaira: 8000 });
    const w = await row(out.id);
    await webhook("transfer.failed", { reference: w.reference, reason: "invalid account" });
    await webhook("transfer.failed", { reference: w.reference });
    assert.strictEqual((await row(out.id)).status, "failed");
    assert.strictEqual(await balance(d), 50000);
    const again = await cashout.requestCashout(d.id, { amountNaira: 8000 });
    assert.ok(again.id !== out.id);
  });

  await test("twenty simultaneous requests for money that covers one debit only once", async () => {
    const d = await readyDriver("Biola Lawal", 12000);
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => cashout.requestCashout(d.id, { amountNaira: 10000 })));
    assert.strictEqual(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.strictEqual(await balance(d), 2000);
    const n = (await pool.query("SELECT count(*)::int AS n FROM wallet_withdrawals WHERE user_id=$1", [d.id])).rows[0].n;
    assert.strictEqual(n, 1);
  });

  await test("the same idempotency key returns the same cash-out instead of a second one", async () => {
    const d = await readyDriver();
    const a = await cashout.requestCashout(d.id, { amountNaira: 5000, idempotencyKey: "tap-1" });
    const b = await cashout.requestCashout(d.id, { amountNaira: 5000, idempotencyKey: "tap-1" });
    assert.strictEqual(a.id, b.id);
    assert.strictEqual(b.duplicate, true);
    assert.strictEqual(await balance(d), 45000);
  });

  await test("the daily limit holds across requests", async () => {
    const d = await readyDriver("Biola Lawal", 100000);
    await cashout.requestCashout(d.id, { amountNaira: 25000 });
    await cashout.requestCashout(d.id, { amountNaira: 25000 });
    await assert.rejects(() => cashout.requestCashout(d.id, { amountNaira: 20000 }), (e) => e.code === "DAILY_LIMIT");
    const left = await cashout.requestCashout(d.id, { amountNaira: 10000 });
    assert.ok(left.id);
  });

  await test("a large request waits for review, then an admin can approve it", async () => {
    const d = await readyDriver("Biola Lawal", 50000);
    const out = await cashout.requestCashout(d.id, { amountNaira: 35000 });
    assert.strictEqual(out.status, "pending_review");
    assert.strictEqual(await balance(d), 15000);
    const before = fake.initiated.length;
    assert.strictEqual(fake.initiated.length, before);
    const res = await call("POST", `/api/admin/cashouts/${out.id}/approve`, adminToken);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.status, "processing");
    assert.strictEqual(fake.initiated.length, before + 1);
    assert.strictEqual((await call("POST", `/api/admin/cashouts/${out.id}/approve`, adminToken)).status, 409);
  });

  await test("declining a large request returns the money, once", async () => {
    const d = await readyDriver("Biola Lawal", 50000);
    const out = await cashout.requestCashout(d.id, { amountNaira: 35000 });
    const res = await call("POST", `/api/admin/cashouts/${out.id}/decline`, adminToken, { reason: "needs ID check" });
    assert.strictEqual(res.body.status, "rejected");
    assert.strictEqual(await balance(d), 50000);
    assert.strictEqual((await call("POST", `/api/admin/cashouts/${out.id}/decline`, adminToken, {})).status, 409);
    assert.strictEqual(await balance(d), 50000);
  });

  await test("a timeout to Paystack does NOT refund; the sweep retries with the same reference", async () => {
    const d = await readyDriver();
    fake.nextInitiate = () => { throw new PaystackError("socket hang up", { network: true }); };
    const out = await cashout.requestCashout(d.id, { amountNaira: 7000 });
    assert.strictEqual(out.status, "queued");
    assert.strictEqual(await balance(d), 43000, "money stays debited while the outcome is unknown");
    const w = await row(out.id);
    await pool.query("UPDATE wallet_withdrawals SET last_attempt_at = now() - interval '5 minutes' WHERE id=$1", [out.id]);
    await cashout.sweepCashouts();
    const after = await row(out.id);
    assert.strictEqual(after.status, "processing");
    assert.strictEqual(fake.initiated.at(-1).reference, w.reference);
    assert.strictEqual(after.attempts, 2);
  });

  await test("if Paystack already has the reference, we verify instead of paying twice", async () => {
    const d = await readyDriver();
    const out = await cashout.requestCashout(d.id, { amountNaira: 7000 });
    const w = await row(out.id);
    // Pretend the first call reached Paystack and succeeded, but we lost the reply.
    fake.transfers[w.reference] = { status: "success", code: "TRF_lost" };
    await pool.query("UPDATE wallet_withdrawals SET status='queued', attempts=1, last_attempt_at = now() - interval '5 minutes' WHERE id=$1", [out.id]);
    await cashout.sweepCashouts();
    const after = await row(out.id);
    assert.strictEqual(after.status, "paid");
    assert.strictEqual(await balance(d), 43000);
  });

  await test("a missed webhook is caught: the sweep verifies old in-flight transfers", async () => {
    const d = await readyDriver();
    const out = await cashout.requestCashout(d.id, { amountNaira: 6000 });
    const w = await row(out.id);
    fake.transfers[w.reference].status = "failed";
    await pool.query("UPDATE wallet_withdrawals SET last_attempt_at = now() - interval '20 minutes' WHERE id=$1", [out.id]);
    await cashout.sweepCashouts();
    assert.strictEqual((await row(out.id)).status, "failed");
    assert.strictEqual(await balance(d), 50000);
  });

  await test("a definite refusal from Paystack (bad recipient) returns the money", async () => {
    const d = await readyDriver();
    fake.nextInitiate = () => { throw new PaystackError("Recipient is invalid", { status: 422 }); };
    const out = await cashout.requestCashout(d.id, { amountNaira: 7000 });
    assert.strictEqual(out.status, "failed");
    assert.strictEqual(await balance(d), 50000);
  });

  await test("when OUR Paystack balance is short the money stays safe and the cash-out stays queued", async () => {
    const d = await readyDriver();
    fake.nextInitiate = () => { throw new PaystackError("Your balance is not enough to fulfil this request", { status: 400 }); };
    const out = await cashout.requestCashout(d.id, { amountNaira: 7000 });
    assert.strictEqual(out.status, "queued");
    assert.strictEqual(await balance(d), 43000);
    assert.ok((await row(out.id)).note.includes("balance"));
  });

  await test("the driver sees a summary with a masked account and clear status labels", async () => {
    const d = await readyDriver();
    await cashout.requestCashout(d.id, { amountNaira: 5000 });
    const res = await call("GET", "/api/cashout", tokenFor(d));
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.bank.accountMasked, "******6789");
    assert.ok(!JSON.stringify(res.body).includes("0123456789"));
    assert.strictEqual(res.body.withdrawableNaira, 45000);
    assert.strictEqual(res.body.history[0].statusLabel, "On its way");
    assert.strictEqual(res.body.enabled, true);
  });

  await test("riders and the operations role cannot use cash-out or the admin list", async () => {
    for (const role of ["rider", "operations", "support"]) {
      const u = await makeUser(role, "Nobody");
      assert.ok([401, 403].includes((await call("GET", "/api/cashout", tokenFor(u))).status));
      assert.ok([401, 403].includes((await call("GET", "/api/admin/cashouts", tokenFor(u))).status));
    }
    const drv = await makeUser("driver", "Biola Lawal");
    assert.ok([401, 403].includes((await call("GET", "/api/admin/cashouts", tokenFor(drv))).status));
    assert.strictEqual((await call("GET", "/api/admin/cashouts", adminToken)).status, 200);
  });

  await test("turning the switch off blocks new requests", async () => {
    await setSwitch(false);
    const d = await readyDriver();
    await assert.rejects(() => cashout.requestCashout(d.id, { amountNaira: 5000 }), (e) => e.code === "CASHOUT_DISABLED");
    await setSwitch(true);
  });

  // Clean up, children before parents.
  await pool.query("DELETE FROM wallet_withdrawals");
  await pool.query("DELETE FROM driver_bank_accounts WHERE user_id = ANY($1::int[])", [created.users]);
  await pool.query("DELETE FROM wallet_transactions WHERE user_id = ANY($1::int[])", [created.users]);
  await pool.query("DELETE FROM system_config WHERE key = 'driver_cashout_enabled'");
  await pool.query("DELETE FROM users WHERE id = ANY($1::int[])", [created.users]);

  console.log(`\n${passed} passed`);
  server.close();
  await pool.end();
})();
