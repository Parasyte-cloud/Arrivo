// Against a REAL Postgres: the ArrivoExpress price book, competitor price log
// and driver quests.
//
//   DATABASE_URL=postgres://... node services/expressPricingAndQuests.integration.test.js
//   npm run test:integration
//
// These are the rules that only prove themselves against a real database:
// a trip is never counted twice, the winner cap holds when drivers finish at
// the same moment, a big price change is refused, and a failed multi-tier
// publish leaves nothing behind.

const assert = require("assert");
const http = require("http");
const jwt = require("jsonwebtoken");

process.env.JWT_SECRET = process.env.JWT_SECRET || "integration-test-secret";
process.env.ARRIVO_NOW_ENABLED = "true";

const express = require("express");
require("express-async-errors");
const { pool, ready } = require("../db/db");

// Route lookups are stubbed so the quote check below needs no network.
const mapsPath = require.resolve("./googleMaps");
require.cache[mapsPath] = {
  id: mapsPath, filename: mapsPath, loaded: true,
  exports: { getDistanceDuration: async () => ({ distanceKm: 10, durationMin: 25 }) },
};

const priceBook = require("./instantPriceBook");
const intel = require("./instantPriceIntel");
const quests = require("./driverQuests");
const { quoteInstantRide } = require("./instantQuote");

let passed = 0;
function test(name, fn) {
  return (async () => {
    try {
      await fn();
      console.log(`  ok  ${name}`);
      passed++;
    } catch (e) {
      console.log(`FAIL  ${name}`);
      console.log(`      ${e.stack || e.message}`);
      process.exitCode = 1;
    }
  })();
}

const app = express();
app.use(express.json());
app.use("/api/admin/express", require("../routes/adminExpress"));
app.use("/api/instant-rides", require("../routes/instantRides"));
app.use((err, req, res, next) => res.status(500).json({ error: "server error", detail: err.message }));
const server = http.createServer(app);

async function call(method, path, token, body) {
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

// Everything this file creates is removed at the end so repeated runs leave
// the database as they found it (other suites, such as the exports one, count rows).
const created = { users: [], rides: [], requests: [], drivers: [], vehicles: [] };

async function makeUser(role, tag) {
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const r = await pool.query(
    `INSERT INTO users (name, email, password_hash, role, agreed_to_terms, wallet_balance_naira)
     VALUES ($1, $2, 'x', $3, true, 0) RETURNING *`,
    [`${tag} ${stamp}`, `${tag}-${stamp}@example.com`, role]
  );
  created.users.push(r.rows[0].id);
  return r.rows[0];
}
const tokenFor = (u) => jwt.sign({ id: u.id, email: u.email, role: u.role }, process.env.JWT_SECRET);

async function makeDriver(rating = 5) {
  const user = await makeUser("driver", "q-driver");
  const vehicle = (await pool.query(
    `INSERT INTO vehicles (owner_user_id, make_model, plate_number, vehicle_type, seats)
     VALUES ($1, 'Test Car', $2, 'sedan', 4) RETURNING id`, [user.id, `Q-${user.id}`])).rows[0];
  const driver = (await pool.query(
    `INSERT INTO drivers (user_id, vehicle_id, is_verified, rating) VALUES ($1, $2, true, $3) RETURNING id`,
    [user.id, vehicle.id, rating])).rows[0];
  created.vehicles.push(vehicle.id);
  created.drivers.push(driver.id);
  return { user, id: driver.id };
}

// A finished ArrivoExpress ride, with sensible defaults a caller can override.
async function makeRide({ driverId, riderId, tier = "economy", km = 8, minutes = 20, status = "completed", started = true } = {}) {
  const rider = riderId ? { id: riderId } : await makeUser("rider", "q-rider");
  const completedAt = new Date();
  const startedAt = started ? new Date(completedAt.getTime() - minutes * 60000) : null;
  const ride = (await pool.query(
    `INSERT INTO rides (rider_id, driver_id, pickup_address, fare_naira, ride_status, tracking_started_at, completed_at)
     VALUES ($1, $2, 'A', 3000, $3, $4, $5) RETURNING id`,
    [rider.id, driverId, status, startedAt, status === "completed" ? completedAt : null])).rows[0];
  created.rides.push(ride.id);
  await pool.query(
    `INSERT INTO instant_ride_requests
       (rider_id, pickup_address, pickup_lat, pickup_lng, destination_address, destination_lat, destination_lng,
        tier, estimated_distance_km, status, matched_driver_id, ride_id)
     VALUES ($1, 'A', 6.5, 3.3, 'B', 6.6, 3.4, $2, $3, 'matched', $4, $5)`,
    [rider.id, tier, km, driverId, ride.id]);
  return { rideId: ride.id, riderId: rider.id };
}

const soon = (hours) => new Date(Date.now() + hours * 3600 * 1000).toISOString();
const baseQuest = (over = {}) => ({
  title: "Test quest", targetTrips: 2, rewardNaira: 5000, maxWinners: 1, endsAt: soon(24), ...over,
});

(async () => {
  await ready;
  await new Promise((resolve) => server.listen(0, resolve));

  // Isolate from anything left by earlier runs.
  await pool.query("DELETE FROM driver_quest_payouts; DELETE FROM driver_quest_trips; DELETE FROM driver_quests; DELETE FROM instant_price_samples; DELETE FROM instant_price_book");
  priceBook.invalidateCache();

  const admin = await makeUser("admin", "pb-admin");
  const adminToken = tokenFor(admin);

  // ── Price book ───────────────────────────────────────────────────────
  await test("with nothing published, every tier uses the code defaults", async () => {
    const sheet = await priceBook.currentPriceSheet();
    assert.strictEqual(sheet.length, 4);
    assert.ok(sheet.every((t) => t.source === "default"));
  });

  await test("a published price takes effect on the next quote", async () => {
    const before = await quoteInstantRide({ tier: "economy", pickupAddress: "Lekki", pickupLat: 6.45, pickupLng: 3.47, destinationAddress: "Ikeja", destinationLat: 6.6, destinationLng: 3.35 });
    assert.strictEqual(before.pricingSource, "default");
    const eco = (await priceBook.currentPriceSheet()).find((t) => t.tier === "economy");
    await priceBook.publishPriceBook({
      tiers: { economy: { ...eco, perKmNaira: Math.round(eco.perKmNaira * 1.1) } },
      note: "daily adjustment", userId: admin.id,
    });
    const after = await quoteInstantRide({ tier: "economy", pickupAddress: "Lekki", pickupLat: 6.45, pickupLng: 3.47, destinationAddress: "Ikeja", destinationLat: 6.6, destinationLng: 3.35 });
    assert.strictEqual(after.pricingSource, "price_book");
    assert.ok(after.fareNaira > before.fareNaira, `${after.fareNaira} should exceed ${before.fareNaira}`);
  });

  await test("a change above 25% is refused unless confirmed with a note", async () => {
    const eco = (await priceBook.currentPriceSheet()).find((t) => t.tier === "economy");
    const doubled = { ...eco, perKmNaira: eco.perKmNaira * 2 };
    await assert.rejects(() => priceBook.publishPriceBook({ tiers: { economy: doubled }, userId: admin.id }), (e) => e.code === "PRICE_CHANGE_TOO_LARGE");
    await assert.rejects(() => priceBook.publishPriceBook({ tiers: { economy: doubled }, confirmLargeChange: true, userId: admin.id }), (e) => e.code === "NOTE_REQUIRED");
    const ok = await priceBook.publishPriceBook({ tiers: { economy: doubled }, confirmLargeChange: true, note: "fuel price jumped sharply", userId: admin.id });
    assert.strictEqual(ok.length, 1);
    // put it back so later tests have sane prices
    await priceBook.publishPriceBook({ tiers: { economy: eco }, confirmLargeChange: true, note: "revert test change", userId: admin.id });
  });

  await test("a scheduled price is not in force until its time", async () => {
    const eco = (await priceBook.currentPriceSheet()).find((t) => t.tier === "comfort");
    await priceBook.publishPriceBook({ tiers: { comfort: { ...eco, baseFareNaira: eco.baseFareNaira + 50, minimumFareNaira: eco.minimumFareNaira + 50 } }, effectiveFrom: soon(6), note: "tomorrow morning", userId: admin.id });
    const now = (await priceBook.currentPriceSheet()).find((t) => t.tier === "comfort");
    assert.strictEqual(now.baseFareNaira, eco.baseFareNaira);
  });

  await test("backdating is refused", async () => {
    const t = (await priceBook.currentPriceSheet())[0];
    await assert.rejects(() => priceBook.publishPriceBook({ tiers: { [t.tier]: t }, effectiveFrom: new Date(Date.now() - 3600000).toISOString(), userId: admin.id }), (e) => e.code === "BACKDATED");
  });

  await test("a failed multi-tier publish leaves nothing behind", async () => {
    const before = (await pool.query("SELECT count(*)::int AS n FROM instant_price_book")).rows[0].n;
    const sheet = await priceBook.currentPriceSheet();
    const xl = sheet.find((t) => t.tier === "xl");
    await assert.rejects(() => priceBook.publishPriceBook({
      tiers: { xl: { ...xl, perKmNaira: xl.perKmNaira + 1 }, premium: { baseFareNaira: -5, perKmNaira: 1, perMinNaira: 1, minimumFareNaira: 1 } },
      userId: admin.id }));
    const after = (await pool.query("SELECT count(*)::int AS n FROM instant_price_book")).rows[0].n;
    assert.strictEqual(after, before);
  });

  await test("history lists published prices newest first", async () => {
    const h = await priceBook.listPriceHistory({ tier: "economy" });
    assert.ok(h.length >= 3);
    assert.ok(new Date(h[0].effectiveFrom) >= new Date(h[1].effectiveFrom));
  });

  // ── Competitor log ───────────────────────────────────────────────────
  await test("logging a sample records what we would have charged", async () => {
    const s = await intel.logSample({ tier: "economy", source: "bolt", distanceKm: 10, durationMin: 25, observedFareNaira: 6000 }, admin.id);
    assert.ok(s.ourFareNaira > 0);
    assert.strictEqual(s.observedFareNaira, 6000);
  });

  await test("a verdict needs at least five samples, then reads the median", async () => {
    let c = await intel.comparison({ days: 7 });
    assert.strictEqual(c.tiers.find((t) => t.tier === "economy").verdict, "not_enough_data");
    for (let i = 0; i < 5; i++) {
      await intel.logSample({ tier: "economy", source: i % 2 ? "uber" : "bolt", distanceKm: 10, durationMin: 25, observedFareNaira: 3000 }, admin.id);
    }
    c = await intel.comparison({ days: 7 });
    const eco = c.tiers.find((t) => t.tier === "economy");
    assert.strictEqual(eco.verdict, "above_market"); // ours is far above NGN 3,000 for 10 km
    assert.ok(eco.suggestedChangePct < 0 && eco.suggestedChangePct >= -20);
  });

  // ── Quests ───────────────────────────────────────────────────────────
  await test("a quest is earned once the target is reached, and only once", async () => {
    const id = (await quests.createQuest(baseQuest({ title: "Earn once", maxWinners: 5 }), admin.id)).id;
    const d = await makeDriver();
    const r1 = await makeRide({ driverId: d.id });
    const o1 = (await quests.recordQuestProgress(r1.rideId)).find((o) => o.questId === id);
    assert.deepStrictEqual([o1.counted, o1.progress, o1.earned], [true, 1, false]);
    const r2 = await makeRide({ driverId: d.id });
    const o2 = (await quests.recordQuestProgress(r2.rideId)).find((o) => o.questId === id);
    assert.deepStrictEqual([o2.progress, o2.earned], [2, true]);
    const r3 = await makeRide({ driverId: d.id });
    const o3 = (await quests.recordQuestProgress(r3.rideId)).find((o) => o.questId === id);
    assert.strictEqual(o3.reason, "already_earned");
    const n = (await pool.query("SELECT count(*)::int AS n FROM driver_quest_payouts WHERE quest_id = $1 AND driver_id = $2", [id, d.id])).rows[0].n;
    assert.strictEqual(n, 1);
    await quests.endQuest(id);
  });

  await test("recording the same ride twice counts it once", async () => {
    const id = (await quests.createQuest(baseQuest({ title: "Idempotent", targetTrips: 5, maxWinners: 5 }), admin.id)).id;
    const d = await makeDriver();
    const r = await makeRide({ driverId: d.id });
    await quests.recordQuestProgress(r.rideId);
    const again = (await quests.recordQuestProgress(r.rideId)).find((o) => o.questId === id);
    assert.strictEqual(again.counted, false);
    assert.strictEqual(again.reason, "already_counted");
    assert.strictEqual((await pool.query("SELECT count(*)::int AS n FROM driver_quest_trips WHERE quest_id = $1", [id])).rows[0].n, 1);
    await quests.endQuest(id);
  });

  await test("trips that should not count do not", async () => {
    const id = (await quests.createQuest(baseQuest({ title: "Strict", targetTrips: 5, maxWinners: 5, tier: "comfort", minDriverRating: 4.5 }), admin.id)).id;
    const d = await makeDriver(5);
    const reasonFor = async (opts) => {
      const o = (await quests.recordQuestProgress((await makeRide({ driverId: d.id, ...opts })).rideId)).find((x) => x.questId === id);
      return o ? (o.counted ? "counted" : o.reason) : "not_considered";
    };
    // A ride of another tier never even reaches the quest (the lookup filters on tier).
    assert.strictEqual(await reasonFor({ tier: "economy" }), "not_considered");
    assert.strictEqual(await reasonFor({ tier: "comfort", km: 0.2 }), "too_short_in_distance");
    assert.strictEqual(await reasonFor({ tier: "comfort", minutes: 1 }), "too_short_in_time");
    assert.strictEqual(await reasonFor({ tier: "comfort", started: false }), "trip_never_started");
    // A ride that never completed has no completion time, so no quest applies at all.
    assert.deepStrictEqual(await quests.recordQuestProgress((await makeRide({ driverId: d.id, tier: "comfort", status: "cancelled" })).rideId), []);
    const lowRated = await makeDriver(3.0);
    const lr = await makeRide({ driverId: lowRated.id, tier: "comfort" });
    assert.strictEqual((await quests.recordQuestProgress(lr.rideId)).find((o) => o.questId === id).reason, "rating_too_low");
    assert.strictEqual(await reasonFor({ tier: "comfort" }), "counted");
    await quests.endQuest(id);
  });

  await test("trips with the same rider stop counting past the per-rider limit", async () => {
    const id = (await quests.createQuest(baseQuest({ title: "No ping-pong", targetTrips: 10, maxWinners: 5, maxTripsPerRider: 2 }), admin.id)).id;
    const d = await makeDriver();
    const rider = await makeUser("rider", "friend");
    const reasons = [];
    for (let i = 0; i < 3; i++) {
      const r = await makeRide({ driverId: d.id, riderId: rider.id });
      reasons.push((await quests.recordQuestProgress(r.rideId)).find((o) => o.questId === id));
    }
    assert.deepStrictEqual(reasons.map((o) => o.counted), [true, true, false]);
    assert.strictEqual(reasons[2].reason, "rider_limit_reached");
    await quests.endQuest(id);
  });

  await test("the winner cap holds when drivers finish at the same moment", async () => {
    const id = (await quests.createQuest(baseQuest({ title: "Race", targetTrips: 1, maxWinners: 2 }), admin.id)).id;
    const rides = [];
    for (let i = 0; i < 6; i++) rides.push((await makeRide({ driverId: (await makeDriver()).id })).rideId);
    await Promise.all(rides.map((rideId) => quests.recordQuestProgress(rideId)));
    const winners = (await pool.query("SELECT count(*)::int AS n FROM driver_quest_payouts WHERE quest_id = $1", [id])).rows[0].n;
    assert.strictEqual(winners, 2);
    await quests.endQuest(id);
  });

  await test("an ended quest stops counting but keeps what was earned", async () => {
    const id = (await quests.createQuest(baseQuest({ title: "Ends early", targetTrips: 1, maxWinners: 5 }), admin.id)).id;
    const d = await makeDriver();
    await quests.recordQuestProgress((await makeRide({ driverId: d.id })).rideId);
    await quests.endQuest(id);
    const after = (await quests.recordQuestProgress((await makeRide({ driverId: (await makeDriver()).id })).rideId)).find((o) => o.questId === id);
    assert.strictEqual(after, undefined);
    assert.strictEqual((await pool.query("SELECT count(*)::int AS n FROM driver_quest_payouts WHERE quest_id = $1", [id])).rows[0].n, 1);
  });

  await test("marking a payout paid is idempotent", async () => {
    const [p] = await quests.listPayouts({ status: "owed" });
    assert.ok(p);
    const first = await quests.markPayoutPaid(p.id, admin.id);
    const second = await quests.markPayoutPaid(p.id, admin.id);
    assert.strictEqual(first.status, "paid");
    assert.deepStrictEqual(new Date(second.paidAt), new Date(first.paidAt));
  });

  await test("a quest that could cost more than the budget cap is refused", async () => {
    await assert.rejects(() => quests.createQuest(baseQuest({ rewardNaira: 100000, maxWinners: 1000 }), admin.id), (e) => e.code === "QUEST_BUDGET_TOO_LARGE");
  });

  await test("a driver sees quests with their own progress", async () => {
    const id = (await quests.createQuest(baseQuest({ title: "Visible", targetTrips: 3, maxWinners: 5 }), admin.id)).id;
    const d = await makeDriver();
    await quests.recordQuestProgress((await makeRide({ driverId: d.id })).rideId);
    const mine = (await quests.listDriverQuests(d.id)).find((q) => q.id === id);
    assert.strictEqual(mine.progress, 1);
    assert.strictEqual(mine.targetTrips, 3);
    assert.strictEqual(mine.earned, false);
    const res = await call("GET", "/api/instant-rides/driver/quests", tokenFor(d.user));
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.quests.some((q) => q.id === id));
    await quests.endQuest(id);
  });

  // ── HTTP: who may do what ────────────────────────────────────────────
  await test("only an admin can use the pricing and quest controls", async () => {
    const rider = await makeUser("rider", "plain-rider");
    const support = await makeUser("support", "plain-support");
    for (const u of [rider, support]) {
      assert.strictEqual((await call("GET", "/api/admin/express/prices", tokenFor(u))).status, 403);
      assert.strictEqual((await call("POST", "/api/admin/express/quests", tokenFor(u), baseQuest())).status, 403);
    }
    const ok = await call("GET", "/api/admin/express/prices", adminToken);
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.body.prices.length, 4);
  });

  await test("the API returns a clear error for a too-large price change", async () => {
    const res = await call("POST", "/api/admin/express/prices", adminToken, {
      tiers: { premium: { baseFareNaira: 9000, perKmNaira: 450, perMinNaira: 65, minimumFareNaira: 9000 } },
    });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.body.code, "PRICE_CHANGE_TOO_LARGE");
  });

  await test("/tiers shows the price in force, not the code default", async () => {
    const eco = (await priceBook.currentPriceSheet()).find((t) => t.tier === "economy");
    await priceBook.publishPriceBook({ tiers: { economy: { ...eco, minimumFareNaira: eco.minimumFareNaira + 100 } }, note: "tiers check", userId: admin.id });
    const rider = await makeUser("rider", "tiers-rider");
    const res = await call("GET", "/api/instant-rides/tiers", tokenFor(rider));
    assert.strictEqual(res.body.tiers.find((t) => t.key === "economy").minimumFareNaira, eco.minimumFareNaira + 100);
  });

  // Clean up, children before parents.
  await pool.query("DELETE FROM driver_quest_payouts; DELETE FROM driver_quest_trips; DELETE FROM driver_quests; DELETE FROM instant_price_samples; DELETE FROM instant_price_book");
  await pool.query("DELETE FROM instant_ride_requests WHERE ride_id = ANY($1::int[])", [created.rides]);
  await pool.query("DELETE FROM rides WHERE id = ANY($1::int[])", [created.rides]);
  await pool.query("DELETE FROM drivers WHERE id = ANY($1::int[])", [created.drivers]);
  await pool.query("DELETE FROM vehicles WHERE id = ANY($1::int[])", [created.vehicles]);
  await pool.query("DELETE FROM users WHERE id = ANY($1::int[])", [created.users]);

  console.log(`\n${passed} passed`);
  server.close();
  await pool.end();
})();
