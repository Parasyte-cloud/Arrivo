const test = require("node:test");
const assert = require("node:assert/strict");
const fc = require("./flightCredit");

const ON = { FLIGHT_CANCEL_CREDIT: "on" };
const paid = { id: 7, booking_type: "one_way", ride_status: "accepted", payment_status: "paid", fare_naira: "85000", rider_id: 3, flight_number: "MEA", flight_date: "2026-11-02" };
const cancelled = { state: "cancelled" };

test("switched off by default: nothing happens", () => {
  assert.equal(fc.decideCredit(paid, cancelled, {}).action, "none");
  assert.equal(fc.decideCredit(paid, cancelled, {}).why, "switched_off");
});

test("a paid arrival with a cancelled flight is credited the whole fare", () => {
  assert.deepEqual(fc.decideCredit(paid, cancelled, ON), { action: "credit", amount: 85000 });
});

test("a pay-later arrival is closed, nothing is held", () => {
  assert.deepEqual(fc.decideCredit({ ...paid, payment_status: "pending" }, cancelled, ON), { action: "close", amount: 0 });
});

test("only cancelled flights, arrivals and open rides are touched", () => {
  assert.equal(fc.decideCredit(paid, { state: "delayed" }, ON).action, "none");
  assert.equal(fc.decideCredit(paid, { state: "unknown" }, ON).action, "none");
  assert.equal(fc.decideCredit({ ...paid, booking_type: "dropoff" }, cancelled, ON).action, "none");
  assert.equal(fc.decideCredit({ ...paid, ride_status: "in_progress" }, cancelled, ON).action, "none");
  assert.equal(fc.decideCredit({ ...paid, ride_status: "completed" }, cancelled, ON).action, "none");
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
      log.push(sql.replace(/\s+/g, " ").trim().slice(0, 60));
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
