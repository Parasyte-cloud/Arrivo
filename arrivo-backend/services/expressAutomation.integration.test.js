// Against a REAL Postgres: automatic quest payout to driver wallets and
// automatic repricing.
//
//   DATABASE_URL=postgres://...localhost... node services/expressAutomation.integration.test.js
//
// What only a real database can prove: a reward is credited exactly once even
// when asked twice at the same moment, the daily cap holds, switches default
// OFF, and the repricing guard rails hold against real price book rows.

const assert = require("assert");
const http = require("http");
const jwt = require("jsonwebtoken");

process.env.JWT_SECRET = process.env.JWT_SECRET || "integration-test-secret";
process.env.ARRIVO_NOW_ENABLED = "true";
process.env.QUEST_AUTO_PAYOUT_DAILY_CAP_NAIRA = "8000";

const express = require("express");
require("express-async-errors");
const { pool, ready } = require("../db/db");
const priceBook = require("./instantPriceBook");
const quests = require("./driverQuests");
const payout = require("./questPayout");
const reprice = require("./autoReprice");
const systemConfig = require("./systemConfig");

let passed = 0;
function test(name, fn) {
  return (async () => {
    try { await fn(); console.log(`  ok  ${name}`); passed++; }
    catch (e) { console.log(`FAIL  ${name}\n      ${e.stack || e.message}`); process.exitCode = 1; }
  })();
}

const app = express();
app.use(express.json());
app.use("/api/admin/express", require("../routes/adminExpress"));
app.use((err, req, res, next) => res.status(500).json({ error: "server error", detail: err.message }));
const server = http.createServer(app);
async function call(method, path, token, body) {
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const created = { users: [], rides: [], drivers: [], vehicles: [] };
async function makeUser(role, tag) {
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const r = await pool.query(
    `INSERT INTO users (name, email, password_hash, role, agreed_to_terms, wallet_balance_naira)
     VALUES ($1, $2, 'x', $3, true, 0) RETURNING *`, [`${tag} ${stamp}`, `${tag}-${stamp}@example.com`, role]);
  created.users.push(r.rows[0].id);
  return r.rows[0];
}
const tokenFor = (u) => jwt.sign({ id: u.id, email: u.email, role: u.role }, process.env.JWT_SECRET);
async function makeDriver() {
  const user = await makeUser("driver", "a-driver");
  const vehicle = (await pool.query(
    `INSERT INTO vehicles (owner_user_id, make_model, plate_number, vehicle_type, seats) VALUES ($1,'Test Car',$2,'sedan',4) RETURNING id`,
    [user.id, `A-${user.id}`])).rows[0];
  const driver = (await pool.query(
    `INSERT INTO drivers (user_id, vehicle_id, is_verified, rating) VALUES ($1,$2,true,5) RETURNING id`, [user.id, vehicle.id])).rows[0];
  created.vehicles.push(vehicle.id); created.drivers.push(driver.id);
  return { user, id: driver.id };
}
// An owed payout for a fresh driver, made through the real quest path.
async function owedPayout(reward = 3000) {
  const d = await makeDriver();
  const rider = await makeUser("rider", "a-rider");
  const questId = (await quests.createQuest({ title: `Auto ${reward}`, targetTrips: 1, rewardNaira: reward, maxWinners: 1, endsAt: new Date(Date.now() + 86400000).toISOString() }, admin.id)).id;
  const completedAt = new Date();
  const ride = (await pool.query(
    `INSERT INTO rides (rider_id, driver_id, pickup_address, fare_naira, ride_status, tracking_started_at, completed_at)
     VALUES ($1,$2,'A',3000,'completed',$3,$4) RETURNING id`, [rider.id, d.id, new Date(completedAt - 20 * 60000), completedAt])).rows[0];
  created.rides.push(ride.id);
  await pool.query(
    `INSERT INTO instant_ride_requests (rider_id, pickup_address, pickup_lat, pickup_lng, destination_address, destination_lat, destination_lng,
       tier, estimated_distance_km, status, matched_driver_id, ride_id)
     VALUES ($1,'A',6.5,3.3,'B',6.6,3.4,'economy',8,'matched',$2,$3)`, [rider.id, d.id, ride.id]);
  const out = (await quests.recordQuestProgress(ride.id)).find((o) => o.questId === questId);
  assert.ok(out && out.earned, "quest should be earned");
  const p = (await pool.query("SELECT id FROM driver_quest_payouts WHERE quest_id = $1", [questId])).rows[0];
  return { payoutId: p.id, driver: d, questId };
}
const wallet = async (userId) => Number((await pool.query("SELECT wallet_balance_naira FROM users WHERE id=$1", [userId])).rows[0].wallet_balance_naira);
const setSwitch = (key, on) => systemConfig.setConfig(key, on ? "true" : "false", admin.id);
const wipe = async () => {
  await pool.query("DELETE FROM driver_quest_payouts; DELETE FROM driver_quest_trips; DELETE FROM driver_quests; DELETE FROM instant_price_samples; DELETE FROM instant_price_book; DELETE FROM express_automation_log");
  priceBook.invalidateCache();
};
let admin;

(async () => {
  await ready;
  await new Promise((r) => server.listen(0, r));
  await wipe();
  await pool.query("DELETE FROM system_config WHERE key IN ('express_auto_payout_enabled','express_auto_reprice_enabled')");
  admin = await makeUser("admin", "auto-admin");
  const adminToken = tokenFor(admin);

  // ── Payout ───────────────────────────────────────────────────────────
  await test("both automation switches default to OFF", async () => {
    assert.strictEqual(await systemConfig.getConfigBool("express_auto_payout_enabled", true), false);
    assert.strictEqual(await systemConfig.getConfigBool("express_auto_reprice_enabled", true), false);
  });

  let p1;
  await test("with the switch off, an earned reward stays owed and nothing is credited", async () => {
    p1 = await owedPayout(3000);
    assert.deepStrictEqual((await payout.autoPayOwed()).enabled, false);
    const row = (await pool.query("SELECT status FROM driver_quest_payouts WHERE id=$1", [p1.payoutId])).rows[0];
    assert.strictEqual(row.status, "owed");
    assert.strictEqual(await wallet(p1.driver.user.id), 0);
  });

  await test("an admin can credit one reward to the wallet: balance, ledger row and payout agree", async () => {
    const res = await call("POST", `/api/admin/express/payouts/${p1.payoutId}/pay-wallet`, adminToken);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.credited, true);
    assert.strictEqual(await wallet(p1.driver.user.id), 3000);
    const tx = (await pool.query("SELECT * FROM wallet_transactions WHERE id=$1", [res.body.walletTransactionId])).rows[0];
    assert.strictEqual(tx.type, "credit");
    assert.strictEqual(Number(tx.amount_naira), 3000);
    assert.strictEqual(Number(tx.balance_after_naira), 3000);
    const row = (await pool.query("SELECT status, paid_via, paid_by, wallet_transaction_id FROM driver_quest_payouts WHERE id=$1", [p1.payoutId])).rows[0];
    assert.strictEqual(row.status, "paid");
    assert.strictEqual(row.paid_via, "wallet");
    assert.strictEqual(row.paid_by, admin.id);
    assert.strictEqual(row.wallet_transaction_id, tx.id);
  });

  await test("paying the same reward again credits nothing more", async () => {
    const res = await call("POST", `/api/admin/express/payouts/${p1.payoutId}/pay-wallet`, adminToken);
    assert.strictEqual(res.body.alreadyPaid, true);
    assert.strictEqual(await wallet(p1.driver.user.id), 3000);
  });

  await test("ten simultaneous attempts credit exactly once", async () => {
    const p = await owedPayout(2500);
    const results = await Promise.all(Array.from({ length: 10 }, () => payout.payToWallet(p.payoutId, { adminId: admin.id })));
    assert.strictEqual(results.filter((r) => r.credited).length, 1);
    assert.strictEqual(await wallet(p.driver.user.id), 2500);
    const n = (await pool.query("SELECT count(*)::int AS n FROM wallet_transactions WHERE user_id=$1", [p.driver.user.id])).rows[0].n;
    assert.strictEqual(n, 1);
  });

  await test("a missing payout is a clear 404", async () => {
    const res = await call("POST", "/api/admin/express/payouts/99999999/pay-wallet", adminToken);
    assert.strictEqual(res.status, 404);
  });

  await test("with the switch ON, a newly earned reward is paid straight away", async () => {
    await setSwitch("express_auto_payout_enabled", true);
    const p = await owedPayout(2000);
    assert.strictEqual(await wallet(p.driver.user.id), 2000);
    const row = (await pool.query("SELECT status, paid_via, paid_by FROM driver_quest_payouts WHERE id=$1", [p.payoutId])).rows[0];
    assert.strictEqual(row.status, "paid");
    assert.strictEqual(row.paid_via, "wallet");
    assert.strictEqual(row.paid_by, null);
  });

  await test("the daily cap holds: rewards past it stay owed and the cap hit is logged once", async () => {
    // cap 8000; today's automatic spend so far is 2000. 3000 fits (5000), the next 3000 fits (8000), the next does not.
    const a = await owedPayout(3000);
    const b = await owedPayout(3000);
    const c = await owedPayout(3000);
    const status = async (x) => (await pool.query("SELECT status FROM driver_quest_payouts WHERE id=$1", [x.payoutId])).rows[0].status;
    assert.strictEqual(await status(a), "paid");
    assert.strictEqual(await status(b), "paid");
    assert.strictEqual(await status(c), "owed");
    assert.strictEqual(await wallet(c.driver.user.id), 0);
    await payout.autoPayOwed();
    const logged = (await pool.query("SELECT count(*)::int AS n FROM express_automation_log WHERE kind='payout' AND action='cap_reached'")).rows[0].n;
    assert.strictEqual(logged, 1);
    global.capped = c;
  });

  await test("an admin can still pay what the cap held back, but only with explicit confirmation", async () => {
    const no = await call("POST", "/api/admin/express/payouts/pay-all-owed", adminToken, {});
    assert.strictEqual(no.status, 400);
    assert.strictEqual(await wallet(global.capped.driver.user.id), 0);
    const yes = await call("POST", "/api/admin/express/payouts/pay-all-owed", adminToken, { confirm: true });
    assert.strictEqual(yes.status, 200);
    assert.ok(yes.body.paid >= 1);
    assert.strictEqual(await wallet(global.capped.driver.user.id), 3000);
  });

  await test("the daily cap ignores manual payments by an admin", async () => {
    assert.strictEqual(await payout.autoPaidTodayNaira(), 8000);
  });

  // ── Repricing ────────────────────────────────────────────────────────
  async function addSamples(tier, ratio, perSource = 5, sources = ["bolt", "uber"]) {
    for (const source of sources) for (let i = 0; i < perSource; i++) {
      await pool.query(
        `INSERT INTO instant_price_samples (observed_on, period, source, tier, distance_km, duration_min, observed_fare_naira, our_fare_naira)
         VALUES ((now() AT TIME ZONE 'Africa/Lagos')::date, 'day', $1, $2, 10, 25, 1000, $3)`, [source, tier, Math.round(1000 * ratio)]);
    }
  }
  const eco = () => priceBook.currentPriceSheet().then((s) => s.find((t) => t.tier === "economy"));

  await test("repricing does nothing while its switch is off", async () => {
    await addSamples("economy", 1.3);
    const r = await reprice.applyAutoReprice({ mode: "auto" });
    assert.strictEqual(r.ran, false);
    assert.strictEqual(r.reason, "disabled");
    assert.strictEqual((await eco()).source, "default");
    assert.strictEqual((await reprice.runDailyReprice()).reason, "disabled");
  });

  await test("the plan is visible to an admin without changing anything", async () => {
    const res = await call("GET", "/api/admin/express/reprice/plan", adminToken);
    assert.strictEqual(res.status, 200);
    const e = res.body.tiers.find((t) => t.tier === "economy");
    assert.strictEqual(e.action, "change");
    assert.strictEqual(e.changePct, -5);
    assert.strictEqual((await eco()).source, "default");
  });

  await test("an admin applying the plan publishes a small AUTO step as a normal price book row", async () => {
    const before = await eco();
    const res = await call("POST", "/api/admin/express/reprice/apply", adminToken);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.applied.length, 1);
    const after = await eco();
    assert.strictEqual(after.source, "price_book");
    assert.strictEqual(after.perKmNaira, Math.round(before.perKmNaira * 0.95));
    const row = (await pool.query("SELECT note FROM instant_price_book WHERE tier='economy' ORDER BY id DESC LIMIT 1")).rows[0];
    assert.ok(row.note.startsWith("AUTO:"));
    const others = await priceBook.currentPriceSheet();
    assert.ok(others.filter((t) => t.tier !== "economy").every((t) => t.source === "default"), "other tiers untouched");
  });

  await test("cooldown: a second run right after changes nothing, and old samples are not reused", async () => {
    const before = await eco();
    const again = await reprice.applyAutoReprice({ mode: "manual", adminId: admin.id });
    assert.strictEqual(again.applied.length, 0);
    const e = again.held.find((h) => h.tier === "economy");
    assert.strictEqual(e.reason, "cooldown");
    assert.deepStrictEqual(await eco(), before);
  });

  await test("two runs at the same moment cannot both change a price", async () => {
    await pool.query("DELETE FROM instant_price_samples; DELETE FROM instant_price_book; DELETE FROM express_automation_log");
    priceBook.invalidateCache();
    await addSamples("comfort", 1.3);
    const rs = await Promise.all([reprice.applyAutoReprice({ mode: "manual" }), reprice.applyAutoReprice({ mode: "manual" })]);
    const total = rs.reduce((n, r) => n + (r.applied ? r.applied.length : 0), 0);
    assert.strictEqual(total, 1);
    const rows = (await pool.query("SELECT count(*)::int AS n FROM instant_price_book WHERE tier='comfort'")).rows[0].n;
    assert.strictEqual(rows, 1);
  });

  await test("sources that disagree move nothing", async () => {
    await pool.query("DELETE FROM instant_price_samples; DELETE FROM instant_price_book");
    priceBook.invalidateCache();
    await addSamples("xl", 1.3, 5, ["bolt"]);
    await addSamples("xl", 0.8, 5, ["uber"]);
    const plan = await reprice.planAutoReprice();
    assert.strictEqual(plan.tiers.find((t) => t.tier === "xl").reason, "sources_disagree");
  });

  await test("the scheduler entry claims a day exactly once", async () => {
    await pool.query("DELETE FROM instant_price_samples; DELETE FROM instant_price_book; DELETE FROM express_automation_log");
    priceBook.invalidateCache();
    await setSwitch("express_auto_reprice_enabled", true);
    await addSamples("premium", 0.8);
    const noon = new Date(); noon.setUTCHours(11, 0, 0, 0); // 12:00 Lagos
    const first = await reprice.runDailyReprice({ now: noon });
    assert.strictEqual(first.ran, true);
    assert.strictEqual(first.applied.length, 1);
    const second = await reprice.runDailyReprice({ now: noon });
    assert.strictEqual(second.reason, "already_ran_today");
    const early = new Date(noon); early.setUTCHours(2, 0, 0, 0); // 03:00 Lagos
    assert.strictEqual((await reprice.runDailyReprice({ now: early })).reason, "too_early");
  });

  // ── Getting the data ─────────────────────────────────────────────────
  const goodRow = (o = {}) => ({ tier: "economy", source: "bolt", distanceKm: 12, durationMin: 30, observedFareNaira: 5000, ...o });

  await test("bulk logging saves every row, or none if any row is bad", async () => {
    await pool.query("DELETE FROM instant_price_samples");
    const ok = await call("POST", "/api/admin/express/samples/bulk", adminToken, { rows: [goodRow(), goodRow({ source: "uber" }), goodRow({ tier: "comfort", observedFareNaira: 7000 })] });
    assert.strictEqual(ok.status, 201);
    assert.strictEqual(ok.body.saved, 3);
    assert.strictEqual((await pool.query("SELECT count(*)::int AS n FROM instant_price_samples")).rows[0].n, 3);
    const bad = await call("POST", "/api/admin/express/samples/bulk", adminToken, { rows: [goodRow(), goodRow({ observedFareNaira: 5 }), goodRow({ source: "taxify" })] });
    assert.strictEqual(bad.status, 400);
    assert.ok(bad.body.error.includes("Row 2") && bad.body.error.includes("Nothing was saved"));
    assert.strictEqual(bad.body.details.length, 2);
    assert.strictEqual((await pool.query("SELECT count(*)::int AS n FROM instant_price_samples")).rows[0].n, 3, "nothing from the bad batch was kept");
  });

  await test("bulk logging refuses an empty or oversized batch", async () => {
    assert.strictEqual((await call("POST", "/api/admin/express/samples/bulk", adminToken, { rows: [] })).status, 400);
    assert.strictEqual((await call("POST", "/api/admin/express/samples/bulk", adminToken, { rows: Array.from({ length: 101 }, () => goodRow()) })).status, 400);
  });

  await test("coverage tells the admin how far each tier is from usable data", async () => {
    await pool.query("DELETE FROM instant_price_samples; DELETE FROM instant_price_book");
    priceBook.invalidateCache();
    await call("POST", "/api/admin/express/samples/bulk", adminToken, { rows: [goodRow(), goodRow(), goodRow({ source: "uber" })] });
    const res = await call("GET", "/api/admin/express/samples/coverage", adminToken);
    assert.strictEqual(res.status, 200);
    const e = res.body.tiers.find((t) => t.tier === "economy");
    assert.strictEqual(e.samples, 3);
    assert.strictEqual(e.ready, false);
    assert.strictEqual(e.needSamples, 5);
    assert.strictEqual(e.needSources, 1);
    const more = Array.from({ length: 6 }, (_, i) => goodRow({ source: i % 2 ? "uber" : "bolt" }));
    await call("POST", "/api/admin/express/samples/bulk", adminToken, { rows: more });
    const after = (await call("GET", "/api/admin/express/samples/coverage", adminToken)).body.tiers.find((t) => t.tier === "economy");
    assert.strictEqual(after.ready, true);
  });

  await test("the standard route list is served for the daily check", async () => {
    const res = await call("GET", "/api/admin/express/samples/routes", adminToken);
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.routes.length >= 10);
    assert.ok(res.body.routes.every((r) => r.label && r.distanceKm > 0 && r.durationMin > 0));
  });

  // ── Admin controls ───────────────────────────────────────────────────
  await test("an admin can read and flip the automation switches, and it is logged", async () => {
    const off = await call("PATCH", "/api/admin/express/automation", adminToken, { key: "express_auto_payout_enabled", enabled: false });
    assert.strictEqual(off.status, 200);
    assert.strictEqual(await systemConfig.getConfigBool("express_auto_payout_enabled", true), false);
    const info = await call("GET", "/api/admin/express/automation", adminToken);
    assert.strictEqual(info.status, 200);
    assert.strictEqual(info.body.switches.length, 3);
    assert.ok(info.body.log.some((l) => l.action === "switched_off"));
    assert.strictEqual(info.body.limits.payoutDailyCapNaira, 8000);
  });

  await test("only the two Express switches can be flipped this way", async () => {
    const bad = await call("PATCH", "/api/admin/express/automation", adminToken, { key: "some_other_key", enabled: true });
    assert.strictEqual(bad.status, 400);
    const bad2 = await call("PATCH", "/api/admin/express/automation", adminToken, { key: "express_auto_payout_enabled", enabled: "yes" });
    assert.strictEqual(bad2.status, 400);
  });

  await test("riders, drivers and the read-only operations role are refused", async () => {
    for (const role of ["rider", "driver", "operations"]) {
      const u = await makeUser(role, "denied");
      for (const [m, path, body] of [
        ["GET", "/api/admin/express/automation"], ["PATCH", "/api/admin/express/automation", { key: "express_auto_payout_enabled", enabled: true }],
        ["POST", "/api/admin/express/reprice/apply"], ["POST", "/api/admin/express/payouts/1/pay-wallet"],
        ["POST", "/api/admin/express/payouts/pay-all-owed", { confirm: true }],
      ]) {
        const res = await call(m, path, tokenFor(u), body);
        assert.ok(res.status === 401 || res.status === 403, `${role} ${m} ${path} got ${res.status}`);
      }
    }
    assert.strictEqual(await systemConfig.getConfigBool("express_auto_payout_enabled", true), false);
  });

  // Clean up, children before parents.
  await wipe();
  await pool.query("DELETE FROM system_config WHERE key IN ('express_auto_payout_enabled','express_auto_reprice_enabled')");
  await pool.query("DELETE FROM wallet_transactions WHERE user_id = ANY($1::int[])", [created.users]);
  await pool.query("DELETE FROM instant_ride_requests WHERE ride_id = ANY($1::int[])", [created.rides]);
  await pool.query("DELETE FROM rides WHERE id = ANY($1::int[])", [created.rides]);
  await pool.query("DELETE FROM drivers WHERE id = ANY($1::int[])", [created.drivers]);
  await pool.query("DELETE FROM vehicles WHERE id = ANY($1::int[])", [created.vehicles]);
  await pool.query("DELETE FROM users WHERE id = ANY($1::int[])", [created.users]);

  console.log(`\n${passed} passed`);
  server.close();
  await pool.end();
})();
