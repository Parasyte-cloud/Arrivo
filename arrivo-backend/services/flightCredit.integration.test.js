// Against a REAL Postgres: the cancelled arrival credit. What only a real database proves: the wallet
// is credited once however many sweeps and Ops clicks race, a family wallet ride is never turned
// into cash, a spent credit cannot be moved, and the search finds people by name.
const assert = require("assert");
process.env.JWT_SECRET = process.env.JWT_SECRET || "integration-test-secret";
process.env.FLIGHT_CANCEL_CREDIT = "on";
const { pool, ready } = require("../db/db");
const fc = require("./flightCredit");

let passed = 0;
const test = async (name, fn) => {
  try { await fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.log(`FAIL  ${name}\n      ${e.stack || e.message}`); process.exitCode = 1; }
};
const tag = `fc${Date.now()}`;
const users = [];
const mkUser = async (name, wallet = 0) => {
  const r = await pool.query(
    `INSERT INTO users (name, email, password_hash, role, agreed_to_terms, wallet_balance_naira, phone) VALUES ($1,$2,'x','rider',true,$3,$4) RETURNING *`,
    [name, `${tag}.${users.length}@test.invalid`, wallet, `+23480${String(Date.now()).slice(-7)}${users.length}`]
  );
  users.push(r.rows[0].id);
  return r.rows[0];
};
const mkRide = async (rider, over = {}) => {
  const v = { fare: 85000, method: "card", status: "accepted", pay: "paid", flight: "MEA215", date: "2026-11-02", surname: "Nasr", type: "one_way", ...over };
  const r = await pool.query(
    `INSERT INTO rides (rider_id, pickup_address, flight_number, fare_naira, booking_type, agreed_cancellation_policy, payment_status, payment_method, ride_status, flight_date, passenger_surname)
     VALUES ($1,'MMIA',$2,$3,$4,true,$5,$6,$7,$8,$9) RETURNING *`,
    [rider.id, v.flight, v.fare, v.type, v.pay, v.method, v.status, v.date, v.surname]
  );
  return r.rows[0];
};
const wallet = async (u) => Number((await pool.query("SELECT wallet_balance_naira FROM users WHERE id=$1", [u.id])).rows[0].wallet_balance_naira);

(async () => {
  await ready;
  const ada = await mkUser("Helene Nasr");
  const pa = await mkUser("Chidi Okafor");

  await test("a card ride is credited once, the ride is cancelled and the ledger matches", async () => {
    const ride = await mkRide(ada);
    const r = await fc.applyCredit(ride.id);
    assert.strictEqual(r.done, true);
    assert.strictEqual(await wallet(ada), 85000);
    const row = (await pool.query("SELECT ride_status, payment_status, flight_issue FROM rides WHERE id=$1", [ride.id])).rows[0];
    assert.deepStrictEqual([row.ride_status, row.payment_status, row.flight_issue], ["cancelled", "credited", "cancelled"]);
    const tx = (await pool.query("SELECT type, amount_naira, balance_after_naira FROM wallet_transactions WHERE ride_id=$1", [ride.id])).rows;
    assert.strictEqual(tx.length, 1);
    assert.deepStrictEqual([tx[0].type, Number(tx[0].amount_naira), Number(tx[0].balance_after_naira)], ["flight_credit", 85000, 85000]);
  });

  await test("five racing sweeps and Ops clicks credit the wallet exactly once", async () => {
    const before = await wallet(ada);
    const ride = await mkRide(ada, { fare: 40000 });
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => fc.applyCredit(ride.id)));
    assert.strictEqual(results.filter((x) => x.done).length, 1);
    assert.strictEqual(await wallet(ada), before + 40000);
    assert.strictEqual((await pool.query("SELECT count(*)::int n FROM flight_credits WHERE ride_id=$1", [ride.id])).rows[0].n, 1);
  });

  await test("family wallet and membership rides are never turned into cash", async () => {
    for (const method of ["family_wallet", "membership"]) {
      const before = await wallet(ada);
      const ride = await mkRide(ada, { method });
      const r = await fc.applyCredit(ride.id);
      assert.strictEqual(r.why, "needs_ops_rail");
      assert.strictEqual(await wallet(ada), before);
      assert.strictEqual((await pool.query("SELECT ride_status FROM rides WHERE id=$1", [ride.id])).rows[0].ride_status, "accepted");
    }
  });

  await test("a ride already under way, and a drop-off, are refused", async () => {
    const a = await mkRide(ada, { status: "in_progress" });
    assert.strictEqual((await fc.applyCredit(a.id)).why, "ride_not_open");
    const b = await mkRide(ada, { type: "dropoff" });
    assert.strictEqual((await fc.applyCredit(b.id)).why, "not_arrival");
  });

  await test("a pay-later ride is closed with no money moved", async () => {
    const before = await wallet(ada);
    const ride = await mkRide(ada, { pay: "pending", method: "card" });
    const r = await fc.applyCredit(ride.id);
    assert.strictEqual(r.done, true);
    assert.strictEqual(r.amount, 0);
    assert.strictEqual(await wallet(ada), before);
    assert.strictEqual((await pool.query("SELECT count(*)::int n FROM flight_credits WHERE ride_id=$1", [ride.id])).rows[0].n, 0);
  });

  await test("convoy companions are cancelled with the main ride", async () => {
    const main = await mkRide(ada, { fare: 10000 });
    await pool.query("UPDATE rides SET fleet_group_id = id WHERE id=$1", [main.id]);
    const comp = await pool.query(
      `INSERT INTO rides (rider_id, pickup_address, flight_number, fare_naira, booking_type, agreed_cancellation_policy, payment_status, payment_method, ride_status, fleet_group_id, is_fleet_companion)
       VALUES ($1,'MMIA','MEA215',0,'one_way',true,'paid','card','accepted',$2,true) RETURNING id`, [ada.id, main.id]);
    await fc.applyCredit(main.id);
    assert.strictEqual((await pool.query("SELECT ride_status FROM rides WHERE id=$1", [comp.rows[0].id])).rows[0].ride_status, "cancelled");
  });

  await test("search finds a credit by name, surname, flight, email and ride number", async () => {
    const ride = await mkRide(ada, { fare: 5000, flight: "TK625", surname: "Demir" });
    await fc.applyCredit(ride.id);
    for (const q of ["helene", "NASR hel", "demir", "tk625", `${tag}.0`, String(ride.id)]) {
      const rows = await fc.searchCredits({ q });
      assert.ok(rows.some((x) => x.ride_id === ride.id || x.user_id === ada.id), `query ${q}`);
    }
    assert.strictEqual((await fc.searchCredits({ q: "zzzznomatch" })).length, 0);
  });

  await test("a credit moves to another account and both ledger sides are written", async () => {
    const owner = await mkUser("Mira Haddad");
    const ride = await mkRide(owner, { fare: 30000 });
    await fc.applyCredit(ride.id);
    const credit = (await pool.query("SELECT id FROM flight_credits WHERE ride_id=$1", [ride.id])).rows[0];
    const beforeTo = await wallet(pa);
    const r = await fc.moveCredit(credit.id, pa.id, { actorId: pa.id, note: "PA booked it" });
    assert.strictEqual(r.done, true);
    assert.strictEqual(await wallet(owner), 0);
    assert.strictEqual(await wallet(pa), beforeTo + 30000);
    assert.strictEqual((await pool.query("SELECT status FROM flight_credits WHERE id=$1", [credit.id])).rows[0].status, "moved");
    assert.strictEqual((await fc.moveCredit(credit.id, pa.id, {})).why, "not_held");
    const events = (await pool.query("SELECT action FROM flight_credit_events WHERE credit_id=$1 ORDER BY id", [credit.id])).rows.map((x) => x.action);
    assert.deepStrictEqual(events, ["created", "moved"]);
  });

  await test("a credit the rider already spent cannot be moved, and nothing changes", async () => {
    const owner = await mkUser("Spent Rider");
    const ride = await mkRide(owner, { fare: 20000 });
    await fc.applyCredit(ride.id);
    await pool.query("UPDATE users SET wallet_balance_naira = 5000 WHERE id=$1", [owner.id]);
    const credit = (await pool.query("SELECT id FROM flight_credits WHERE ride_id=$1", [ride.id])).rows[0];
    const r = await fc.moveCredit(credit.id, pa.id, {});
    assert.strictEqual(r.why, "already_spent");
    assert.strictEqual(await wallet(owner), 5000);
    assert.strictEqual((await pool.query("SELECT status FROM flight_credits WHERE id=$1", [credit.id])).rows[0].status, "held");
  });

  await test("the database refuses a zero or negative credit", async () => {
    const ride = await mkRide(ada);
    await assert.rejects(pool.query("INSERT INTO flight_credits (ride_id, user_id, amount_naira) VALUES ($1,$2,0)", [ride.id, ada.id]));
  });

  console.log(`\n${passed} passed`);
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
