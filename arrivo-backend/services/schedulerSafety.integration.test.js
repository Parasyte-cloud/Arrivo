// Against a REAL Postgres: the background sweep stays safe when two copies run
// at once (two Render instances, or one slow sweep overlapping the next).
// Push, WhatsApp and email are swapped for counters so we can see exactly how
// many messages went out.

const assert = require("assert");

const sent = { push: [], whatsapp: [], email: [] };
const push = require("./pushNotifications");
push.sendPushNotification = async (...args) => { sent.push.push(args); };
const whatsapp = require("./whatsapp");
whatsapp.sendWhatsAppMessage = async (...args) => { sent.whatsapp.push(args); };
const email = require("./email");
email.sendFlightIssueEmail = async (...args) => { sent.email.push(args); };
email.sendDriverChangedEmail = async (...args) => { sent.email.push(args); };

const { pool, ready } = require("../db/db");
const scheduler = require("./scheduler");

let passed = 0;
const test = async (name, fn) => {
  try { await fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.log(`FAIL  ${name}\n      ${e.stack || e.message}`); process.exitCode = 1; }
};
const reset = () => { sent.push.length = 0; sent.whatsapp.length = 0; sent.email.length = 0; };
const tick = () => new Promise((r) => setTimeout(r, 50));

async function makeUser(role, extra = {}) {
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return (await pool.query(
    `INSERT INTO users (name, email, password_hash, role, agreed_to_terms, wallet_balance_naira, push_token, whatsapp_number)
     VALUES ($1, $2, 'x', $3, true, 0, $4, $5) RETURNING *`,
    [`Sweep ${role}`, `sweep-${tag}@example.com`, role, extra.pushToken || null, extra.whatsapp || null]
  )).rows[0];
}

(async () => {
  await ready;

  await test("two sweeps at once on one instance: the second one is skipped", async () => {
    let runs = 0;
    const slow = async () => { runs++; await new Promise((r) => setTimeout(r, 200)); };
    const results = await Promise.all([scheduler.sweepIfFree({ run: slow }), scheduler.sweepIfFree({ run: slow })]);
    assert.deepStrictEqual(results.sort(), ["busy", "ran"]);
    assert.strictEqual(runs, 1);
  });

  await test("another instance holding the sweep lock: this one skips, then runs once it's free", async () => {
    const other = await pool.connect();
    try {
      await other.query("SELECT pg_advisory_lock(7710100)");
      let runs = 0;
      assert.strictEqual(await scheduler.sweepIfFree({ run: async () => { runs++; } }), "locked");
      assert.strictEqual(runs, 0);
      await other.query("SELECT pg_advisory_unlock(7710100)");
      assert.strictEqual(await scheduler.sweepIfFree({ run: async () => { runs++; } }), "ran");
      assert.strictEqual(runs, 1);
    } finally {
      other.release();
    }
  });

  await test("a cancelled flight refunds the fare once, even when two sweeps flag it together", async () => {
    reset();
    const rider = await makeUser("rider", { pushToken: "ExponentPushToken[rider-flight]", whatsapp: "+2348000000001" });
    const ride = (await pool.query(
      `INSERT INTO rides (rider_id, pickup_address, fare_naira, ride_status, payment_status, booking_type, flight_number, scheduled_pickup_at)
       VALUES ($1, 'Murtala Muhammed Airport', 20000, 'accepted', 'paid', 'dropoff', 'BA75', now() + interval '1 day') RETURNING *`,
      [rider.id]
    )).rows[0];
    const row = { ...ride, rider_push_token: rider.push_token, rider_whatsapp_number: rider.whatsapp_number, rider_email: rider.email };

    await Promise.all([scheduler.flagFlightIssue({ ...row }, "cancelled"), scheduler.flagFlightIssue({ ...row }, "cancelled")]);
    await tick();

    const balance = Number((await pool.query("SELECT wallet_balance_naira FROM users WHERE id = $1", [rider.id])).rows[0].wallet_balance_naira);
    assert.strictEqual(balance, 20000);
    const refunds = (await pool.query("SELECT count(*)::int AS n FROM wallet_transactions WHERE ride_id = $1 AND type = 'refund'", [ride.id])).rows[0].n;
    assert.strictEqual(refunds, 1);
    assert.strictEqual(sent.push.length, 1);
    assert.strictEqual(sent.whatsapp.length, 1);
    assert.strictEqual(sent.email.length, 1);
  });

  await test("pickup reminders go out once each, even when two sweeps hit the same ride", async () => {
    reset();
    const rider = await makeUser("rider", { pushToken: "ExponentPushToken[rider-reminder]" });
    const ride = (await pool.query(
      `INSERT INTO rides (rider_id, pickup_address, fare_naira, ride_status, booking_type, scheduled_pickup_at)
       VALUES ($1, 'Lekki Phase 1', 15000, 'requested', 'dropoff', now() + interval '30 minutes') RETURNING *`,
      [rider.id]
    )).rows[0];
    const row = { ...ride, rider_push_token: rider.push_token, driver_push_token: null };

    // 30 minutes out: the 5h, 3h and 1h reminders are all due, "now" isn't yet.
    await Promise.all([scheduler.maybeSendAndMark({ ...row }, 0.5), scheduler.maybeSendAndMark({ ...row }, 0.5)]);
    await tick();

    assert.strictEqual(sent.push.length, 3);
    const flags = (await pool.query("SELECT reminder_5h_sent, reminder_3h_sent, reminder_1h_sent, reminder_now_sent FROM rides WHERE id = $1", [ride.id])).rows[0];
    assert.deepStrictEqual(flags, { reminder_5h_sent: true, reminder_3h_sent: true, reminder_1h_sent: true, reminder_now_sent: false });
  });

  await test("an expired preferred driver is cleared and the rider told once, with two sweeps racing", async () => {
    reset();
    const rider = await makeUser("rider", { pushToken: "ExponentPushToken[rider-pref]", whatsapp: "+2348000000002" });
    const driverUser = await makeUser("driver");
    const driver = (await pool.query("INSERT INTO drivers (user_id) VALUES ($1) RETURNING id", [driverUser.id])).rows[0];
    const ride = (await pool.query(
      `INSERT INTO rides (rider_id, pickup_address, fare_naira, ride_status, booking_type, scheduled_pickup_at, preferred_driver_id)
       VALUES ($1, 'Ikeja GRA', 12000, 'requested', 'dropoff', now() + interval '2 hours', $2) RETURNING id`,
      [rider.id, driver.id]
    )).rows[0];

    await Promise.all([scheduler.sweepPreferredDriverExpiry(), scheduler.sweepPreferredDriverExpiry()]);
    await tick();

    const after = (await pool.query("SELECT preferred_driver_id FROM rides WHERE id = $1", [ride.id])).rows[0];
    assert.strictEqual(after.preferred_driver_id, null);
    const toRider = sent.whatsapp.filter(([to]) => to === "+2348000000002").length;
    assert.strictEqual(toRider, 1);
    assert.strictEqual(sent.push.filter(([token]) => token === "ExponentPushToken[rider-pref]").length, 1);
  });

  console.log(`\n${passed} passed`);
  await pool.end();
})();
