// Unit tests (no database) for the rules behind the ArrivoExpress price book,
// competitor comparison and driver quests:  node services/expressPricingPure.test.js

const assert = require("assert");
const { validatePriceEntry, defaultPricing } = require("./instantPriceBook");
const { validateSample, buildComparison } = require("./instantPriceIntel");
const { validateQuest, evaluateTrip } = require("./driverQuests");
const { baselineFare, computeInstantFare } = require("./instantFare");

let passed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
    passed++;
  } catch (e) {
    console.error(`  FAIL  ${name}`);
    console.error(e);
    process.exitCode = 1;
  }
}
const throwsCode = (fn, code) => assert.throws(fn, (e) => e.code === code, `expected ${code}`);

const eco = defaultPricing("economy");

// ── price entries ────────────────────────────────────────────────────
test("an unchanged price is accepted", () => {
  assert.deepStrictEqual(validatePriceEntry("economy", eco, eco), eco);
});
test("a change within 25% is accepted", () => {
  const p = { ...eco, perKmNaira: Math.round(eco.perKmNaira * 1.2) };
  assert.strictEqual(validatePriceEntry("economy", p, eco).perKmNaira, p.perKmNaira);
});
test("a change above 25% needs confirmation and a real note", () => {
  const p = { ...eco, perKmNaira: eco.perKmNaira * 2 };
  throwsCode(() => validatePriceEntry("economy", p, eco), "PRICE_CHANGE_TOO_LARGE");
  throwsCode(() => validatePriceEntry("economy", p, eco, { confirmLargeChange: true, note: "short" }), "NOTE_REQUIRED");
  assert.ok(validatePriceEntry("economy", p, eco, { confirmLargeChange: true, note: "fuel price jumped sharply" }));
});
test("a typo with an extra zero is stopped even when confirmed", () => {
  const p = { ...eco, perKmNaira: eco.perKmNaira * 100 };
  throwsCode(() => validatePriceEntry("economy", p, eco, { confirmLargeChange: true, note: "intentional change" }), "PRICE_TOO_HIGH");
});
test("non-integers, zero and negatives are rejected", () => {
  throwsCode(() => validatePriceEntry("economy", { ...eco, baseFareNaira: 600.5 }, eco), "INVALID_PRICE");
  throwsCode(() => validatePriceEntry("economy", { ...eco, perKmNaira: 0 }, eco), "INVALID_PRICE");
  throwsCode(() => validatePriceEntry("economy", { ...eco, baseFareNaira: -1 }, eco), "INVALID_PRICE");
  throwsCode(() => validatePriceEntry("economy", { ...eco, perMinNaira: "abc" }, eco), "INVALID_PRICE");
  throwsCode(() => validatePriceEntry("economy", { baseFareNaira: 600 }, eco), "INVALID_PRICE");
});
test("the minimum fare cannot be below the base fare", () => {
  throwsCode(() => validatePriceEntry("economy", { ...eco, minimumFareNaira: eco.baseFareNaira - 1 }, eco), "INVALID_PRICE");
});
test("an unknown tier is rejected", () => {
  throwsCode(() => validatePriceEntry("limo", eco, eco), "UNKNOWN_TIER");
});

// ── fare override ────────────────────────────────────────────────────
test("a price override changes the fare, and the default does not", () => {
  const trip = { tier: "economy", pickupAddress: "Lekki", destinationAddress: "Ikeja", distanceKm: 10, durationMin: 25 };
  const base = computeInstantFare(trip).fareNaira;
  const dearer = computeInstantFare({ ...trip, pricing: { ...eco, perKmNaira: eco.perKmNaira + 40 } }).fareNaira;
  assert.ok(dearer > base);
  assert.strictEqual(computeInstantFare({ ...trip, pricing: eco }).fareNaira, base);
});
test("baselineFare rounds like a real quote and applies night only when asked", () => {
  const day = baselineFare(eco, 10, 25);
  assert.strictEqual(day % 50, 0);
  assert.ok(baselineFare(eco, 10, 25, { night: true }) > day);
  assert.strictEqual(baselineFare(eco, 0.1, 1), baselineFare(eco, 0, 0)); // both hit the minimum
});

// ── competitor samples and comparison ────────────────────────────────
const goodSample = { tier: "economy", source: "bolt", distanceKm: 10, durationMin: 25, observedFareNaira: 5000 };
test("a good sample is accepted and cleaned", () => {
  const s = validateSample({ ...goodSample, source: "BOLT" });
  assert.strictEqual(s.source, "bolt");
  assert.strictEqual(s.period, "day");
});
test("bad samples are rejected", () => {
  for (const bad of [
    { tier: "limo" }, { source: "taxi" }, { distanceKm: 0.1 }, { distanceKm: 500 },
    { durationMin: 0 }, { observedFareNaira: 50 }, { observedFareNaira: 12.5 },
    { observedOn: "tomorrow" }, { observedOn: "2999-01-01" }, { period: "dusk" },
  ]) {
    assert.throws(() => validateSample({ ...goodSample, ...bad }), (e) => e.code === "INVALID_PRICE_SAMPLE", JSON.stringify(bad));
  }
});
const rows = (ratio, n, tier = "economy") => Array.from({ length: n }, (_, i) => ({ tier, source: i % 2 ? "uber" : "bolt", observed_fare_naira: 1000, our_fare_naira: Math.round(1000 * ratio) }));
test("fewer than five samples gives no verdict", () => {
  const eco4 = buildComparison(rows(1.3, 4)).find((t) => t.tier === "economy");
  assert.strictEqual(eco4.verdict, "not_enough_data");
  assert.strictEqual(eco4.suggestedChangePct, null);
});
test("dearer, in line and cheaper are told apart, with a capped suggestion", () => {
  const v = (ratio) => buildComparison(rows(ratio, 6)).find((t) => t.tier === "economy");
  assert.strictEqual(v(1.3).verdict, "above_market");
  assert.ok(v(1.3).suggestedChangePct < 0 && v(1.3).suggestedChangePct >= -20);
  assert.strictEqual(v(1.02).verdict, "in_line");
  assert.strictEqual(v(1.02).suggestedChangePct, 0);
  assert.strictEqual(v(0.7).verdict, "below_market");
  assert.ok(v(0.7).suggestedChangePct > 0 && v(0.7).suggestedChangePct <= 20);
  assert.strictEqual(v(3).suggestedChangePct, -20); // capped, never invites a jump the guard would refuse
});
test("one odd sample cannot swing the verdict (median, not mean)", () => {
  const data = [...rows(1.0, 6), { tier: "economy", source: "other", observed_fare_naira: 1000, our_fare_naira: 9000 }];
  assert.strictEqual(buildComparison(data).find((t) => t.tier === "economy").verdict, "in_line");
});
test("tiers are compared separately", () => {
  const out = buildComparison([...rows(1.4, 6, "economy"), ...rows(0.6, 6, "premium")]);
  assert.strictEqual(out.find((t) => t.tier === "economy").verdict, "above_market");
  assert.strictEqual(out.find((t) => t.tier === "premium").verdict, "below_market");
  assert.strictEqual(out.find((t) => t.tier === "comfort").verdict, "not_enough_data");
});

// ── quests ───────────────────────────────────────────────────────────
const NOW = new Date("2026-10-09T12:00:00Z");
const quest = (over = {}) => ({ title: "Weekend", targetTrips: 10, rewardNaira: 5000, maxWinners: 50, endsAt: "2026-10-12T12:00:00Z", startsAt: "2026-10-09T12:00:00Z", ...over });
test("a normal quest is accepted and its worst-case cost reported", () => {
  const q = validateQuest(quest(), NOW);
  assert.strictEqual(q.maxLiabilityNaira, 250000);
  assert.strictEqual(q.maxTripsPerRider, 2);
});
test("quest limits are enforced", () => {
  for (const bad of [
    { title: "ab" }, { targetTrips: 0 }, { targetTrips: 500 }, { rewardNaira: 50 }, { maxWinners: 0 },
    { tier: "limo" }, { endsAt: "2026-10-09T11:00:00Z" }, { endsAt: "2026-12-30T00:00:00Z" },
    { endsAt: "not a date" }, { minTripKm: 0.1 }, { minDriverRating: 9 },
  ]) {
    assert.throws(() => validateQuest(quest(bad), NOW), (e) => e.name === "QuestError", JSON.stringify(bad));
  }
});
test("a quest above the budget cap is refused with its own code", () => {
  throwsCode(() => validateQuest(quest({ rewardNaira: 50000, maxWinners: 1000 }), NOW), "QUEST_BUDGET_TOO_LARGE");
});

const q = { starts_at: "2026-10-09T00:00:00Z", ends_at: "2026-10-12T00:00:00Z", tier: null, min_trip_km: 1, min_trip_minutes: 3, max_trips_per_rider: 2, min_driver_rating: null };
const trip = (over = {}) => ({ rideStatus: "completed", completedAt: "2026-10-10T10:20:00Z", trackingStartedAt: "2026-10-10T10:00:00Z", distanceKm: 8, tier: "economy", driverRating: 4.9, ...over });
test("a real finished trip counts", () => {
  assert.deepStrictEqual(evaluateTrip(q, trip()), { counts: true, reason: "ok" });
});
test("each disqualifier is named", () => {
  const why = (t, quest = q, ctx) => evaluateTrip(quest, t, ctx).reason;
  assert.strictEqual(why(trip({ rideStatus: "cancelled" })), "not_completed");
  assert.strictEqual(why(trip({ completedAt: "2026-10-13T10:00:00Z" })), "outside_window");
  assert.strictEqual(why(trip({ completedAt: "2026-10-08T10:00:00Z", trackingStartedAt: "2026-10-08T09:40:00Z" })), "outside_window");
  assert.strictEqual(why(trip({ tier: "xl" }), { ...q, tier: "economy" }), "tier_mismatch");
  assert.strictEqual(why(trip({ trackingStartedAt: null })), "trip_never_started");
  assert.strictEqual(why(trip({ trackingStartedAt: "2026-10-10T10:19:00Z" })), "too_short_in_time");
  assert.strictEqual(why(trip({ distanceKm: 0.4 })), "too_short_in_distance");
  assert.strictEqual(why(trip(), q, { riderTripsAlready: 2 }), "rider_limit_reached");
  assert.strictEqual(why(trip({ driverRating: 4.1 }), { ...q, min_driver_rating: 4.5 }), "rating_too_low");
});
test("missing numbers fail closed", () => {
  assert.strictEqual(evaluateTrip(q, trip({ distanceKm: undefined })).counts, false);
  assert.strictEqual(evaluateTrip({ ...q, min_driver_rating: 4.5 }, trip({ driverRating: null })).counts, false);
});

console.log(`${passed} passed`);
