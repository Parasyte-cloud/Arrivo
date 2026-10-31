const test = require("node:test");
const assert = require("node:assert/strict");
const fc = require("./flightCredit");

const ON = { FLIGHT_CANCEL_CREDIT: "on" };
const NOW = Date.parse("2026-11-02T10:00:00Z");
const tenMinAgo = new Date(NOW - 10 * 60 * 1000).toISOString();
// The row as it was before this sweep: the last sweep already saw the flight cancelled.
const paid = { id: 7, booking_type: "one_way", ride_status: "accepted", payment_status: "paid", payment_method: "card", fare_naira: "85000", rider_id: 3, flight_number: "MEA", flight_date: "2026-11-02", flight_date_str: "2026-11-02", flight_tracking_state: "cancelled", flight_checked_at: tenMinAgo };
const cancelled = { state: "cancelled" };

test("switched off by default: nothing happens", () => {
  assert.equal(fc.decideCredit(paid, cancelled, {}, NOW).action, "none");
  assert.equal(fc.decideCredit(paid, cancelled, {}, NOW).why, "switched_off");
});

test("a paid arrival with a cancelled flight is credited the whole fare", () => {
  assert.deepEqual(fc.decideCredit(paid, cancelled, ON, NOW), { action: "credit", amount: 85000 });
});

test("a pay-later arrival is closed, nothing is held", () => {
  assert.deepEqual(fc.decideCredit({ ...paid, payment_status: "pending" }, cancelled, ON, NOW), { action: "close", amount: 0 });
});

test("only cancelled flights, arrivals and open rides are touched", () => {
  assert.equal(fc.decideCredit(paid, { state: "delayed" }, ON, NOW).action, "none");
  assert.equal(fc.decideCredit(paid, { state: "unknown" }, ON, NOW).action, "none");
  assert.equal(fc.decideCredit({ ...paid, booking_type: "dropoff" }, cancelled, ON, NOW).action, "none");
  assert.equal(fc.decideCredit({ ...paid, ride_status: "in_progress" }, cancelled, ON, NOW).action, "none");
  assert.equal(fc.decideCredit({ ...paid, ride_status: "completed" }, cancelled, ON, NOW).action, "none");
});

test("names match without case, accents or order; Arabic and Turkish survive", () => {
  assert.ok(fc.nameMatches("helene", "Hélène Nasr"));
  assert.ok(fc.nameMatches("nasr hel", "Hélène Nasr"));
  assert.ok(fc.nameMatches("ISIK", "Işık Demir"));
  assert.ok(fc.nameMatches("نصر", "جورج نصر"));
  assert.ok(!fc.nameMatches("obi", "Hélène Nasr"));
  assert.ok(!fc.nameMatches("", "Hélène Nasr"));
});

// A tiny scripted database: answers by looking at the SQL, records every statement.
function fakeDb(script) {
  const log = [];
  const client = {
    async query(sql, params) {
      log.push(sql.replace(/\s+/g, " ").trim().slice(0, 100));
      for (const [needle, answer] of script) if (sql.includes(needle)) return typeof answer === "function" ? answer(params) : answer;
      return { rows: [] };
    },
    release() { log.push("RELEASE"); },
  };
  return { log, connect: async () => client, query: client.query };
}

test("applyCredit moves the money once and cancels the ride", async () => {
  const db = fakeDb([
    ["SELECT * FROM rides", { rows: [paid] }],
    ["INSERT INTO flight_credits", { rows: [{ id: 11 }] }],
    ["UPDATE users SET wallet_balance_naira", { rows: [{ wallet_balance_naira: "85000" }] }],
    ["INSERT INTO wallet_transactions", { rows: [{ id: 99 }] }],
  ]);
  const r = await fc.applyCredit(7, { env: ON, db });
  assert.equal(r.done, true);
  assert.equal(r.amount, 85000);
  assert.ok(db.log.includes("COMMIT"));
  assert.ok(db.log.some((l) => l.startsWith("UPDATE rides SET ride_status = 'cancelled'")));
});

test("applyCredit does nothing the second time", async () => {
  const db = fakeDb([["SELECT * FROM rides", { rows: [paid] }], ["INSERT INTO flight_credits", { rows: [] }]]);
  const r = await fc.applyCredit(7, { env: ON, db });
  assert.deepEqual([r.done, r.why], [false, "already_credited"]);
  assert.ok(db.log.includes("ROLLBACK"));
  assert.ok(!db.log.some((l) => l.includes("wallet_balance_naira")));
});

test("applyCredit writes nothing while the switch is off", async () => {
  const db = fakeDb([]);
  const r = await fc.applyCredit(7, { env: {}, db });
  assert.equal(r.why, "switched_off");
  assert.equal(db.log.length, 0);
});

test("a ride that already started is never credited", async () => {
  const db = fakeDb([["SELECT * FROM rides", { rows: [{ ...paid, ride_status: "in_progress" }] }]]);
  const r = await fc.applyCredit(7, { env: ON, db });
  assert.equal(r.why, "ride_not_open");
});

test("moveCredit refuses when the rider already spent it", async () => {
  const db = fakeDb([
    ["SELECT * FROM flight_credits", { rows: [{ id: 11, user_id: 3, ride_id: 7, amount_naira: "85000", status: "held" }] }],
    ["SELECT id FROM users", { rows: [{ id: 9 }] }],
    ["wallet_balance_naira - $1", { rows: [] }],
  ]);
  const r = await fc.moveCredit(11, 9, { actorId: 1, db });
  assert.equal(r.why, "already_spent");
  assert.ok(db.log.includes("ROLLBACK"));
});

test("moveCredit writes both sides of the ledger and marks the credit moved", async () => {
  const db = fakeDb([
    ["SELECT * FROM flight_credits", { rows: [{ id: 11, user_id: 3, ride_id: 7, amount_naira: "85000", status: "held" }] }],
    ["SELECT id FROM users", { rows: [{ id: 9 }] }],
    ["wallet_balance_naira - $1", { rows: [{ wallet_balance_naira: "0" }] }],
    ["wallet_balance_naira + $1", { rows: [{ wallet_balance_naira: "85000" }] }],
  ]);
  const r = await fc.moveCredit(11, 9, { actorId: 1, note: "PA booked it", db });
  assert.equal(r.done, true);
  assert.equal(db.log.filter((l) => l.startsWith("INSERT INTO wallet_transactions")).length, 2);
  assert.ok(db.log.some((l) => l.startsWith("UPDATE flight_credits SET status = 'moved'")));
  assert.ok(db.log.includes("COMMIT"));
});

test("moveCredit refuses a credit that is not held, or the same account", async () => {
  let db = fakeDb([["SELECT * FROM flight_credits", { rows: [{ id: 11, user_id: 3, status: "moved" }] }]]);
  assert.equal((await fc.moveCredit(11, 9, { db })).why, "not_held");
  db = fakeDb([["SELECT * FROM flight_credits", { rows: [{ id: 11, user_id: 9, status: "held" }] }]]);
  assert.equal((await fc.moveCredit(11, 9, { db })).why, "same_account");
});

test("one provider reading is never enough: the first sighting only waits", () => {
  const first = { ...paid, flight_tracking_state: "tracked", flight_checked_at: tenMinAgo };
  assert.deepEqual(fc.decideCredit(first, cancelled, ON, NOW), { action: "wait", why: "first_sighting" });
  const tooSoon = { ...paid, flight_checked_at: new Date(NOW - 5 * 60 * 1000).toISOString() };
  assert.equal(fc.decideCredit(tooSoon, cancelled, ON, NOW).action, "wait");
});

test("a lookup that was not pinned to a date never moves money on its own", () => {
  const undated = { ...paid, flight_date: null, flight_date_str: null };
  assert.deepEqual([fc.decideCredit(undated, cancelled, ON, NOW).action, fc.decideCredit(undated, cancelled, ON, NOW).why], ["none", "no_flight_date"]);
});

test("family wallet and membership rides are left to Ops: crediting the rider would mint cash", () => {
  for (const method of ["family_wallet", "membership"]) {
    const r = fc.decideCredit({ ...paid, payment_method: method }, cancelled, ON, NOW);
    assert.deepEqual([r.action, r.why], ["none", "needs_ops_rail"]);
  }
  assert.equal(fc.decideCredit({ ...paid, payment_method: "wallet" }, cancelled, ON, NOW).action, "credit");
});

test("extra convoy vehicles are never decided on their own", () => {
  assert.equal(fc.decideCredit({ ...paid, is_fleet_companion: true }, cancelled, ON, NOW).why, "fleet_companion");
});

test("applyCredit refuses a family wallet ride even when Ops asks", async () => {
  const db = fakeDb([["SELECT * FROM rides", { rows: [{ ...paid, payment_method: "family_wallet" }] }]]);
  const r = await fc.applyCredit(7, { env: ON, db });
  assert.equal(r.why, "needs_ops_rail");
  assert.ok(db.log.includes("ROLLBACK"));
  assert.ok(!db.log.some((l) => l.includes("INSERT INTO flight_credits")));
});

test("applyCredit cancels the convoy with the main ride", async () => {
  const db = fakeDb([
    ["SELECT * FROM rides", { rows: [paid] }],
    ["INSERT INTO flight_credits", { rows: [{ id: 11 }] }],
    ["UPDATE users SET wallet_balance_naira", { rows: [{ wallet_balance_naira: "85000" }] }],
    ["INSERT INTO wallet_transactions", { rows: [{ id: 99 }] }],
  ]);
  await fc.applyCredit(7, { env: ON, db });
  assert.ok(db.log.some((l) => l.startsWith("UPDATE rides SET ride_status = 'cancelled', flight_issue = 'cancelled', updated_at")));
});
