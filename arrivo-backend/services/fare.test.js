// Tests for Arrivo Fair Fare's overage calculation (services/fare.js
// computeFairFareOverageNaira). Hand-rolled test runner, matching the
// convention already established by services/instantFare.test.js — no new
// test framework dependency. Run directly with:
//   node services/fare.test.js

const assert = require("assert");
const {
  computeFairFareOverageNaira,
  activeLaunchPromo,
  isLuckyRideWindow,
  applyLaunchPromoDiscount,
  lagosDateString,
} = require("./fare");

// Builds a UTC Date that corresponds to a given Africa/Lagos (UTC+1) local
// time, so the promo-window tests below read as "at 5am Lagos time" rather
// than juggling UTC offsets inline.
function lagosTime(hour, minute = 0) {
  const utcHour = (hour - 1 + 24) % 24;
  return new Date(Date.UTC(2026, 0, 1, utcHour, minute));
}

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

console.log("Arrivo Fair Fare — overage calculation:");

test("delay within the free allowance costs nothing (brief's own worked example)", () => {
  // Lekki -> Victoria Island, ₦4,000 quoted, 20 min allowance, exactly 20 min of delay.
  const result = computeFairFareOverageNaira({
    quotedDurationMin: 30,
    elapsedMinutes: 50, // 20 min delay
    freeAllowanceMinutes: 20,
    perMinuteNaira: 100,
    fareNaira: 4000,
  });
  assert.strictEqual(result.overageNaira, 0);
  assert.strictEqual(result.delayMinutes, 20);
  assert.strictEqual(result.billableMinutes, 0);
});

test("delay beyond the allowance is billed only for the minutes past it", () => {
  const result = computeFairFareOverageNaira({
    quotedDurationMin: 30,
    elapsedMinutes: 55, // 25 min delay, 20 min allowance -> 5 billable min
    freeAllowanceMinutes: 20,
    perMinuteNaira: 100,
    fareNaira: 4000,
  });
  assert.strictEqual(result.delayMinutes, 25);
  assert.strictEqual(result.billableMinutes, 5);
  assert.strictEqual(result.overageNaira, 500);
});

test("arriving faster than quoted is never a negative charge", () => {
  const result = computeFairFareOverageNaira({
    quotedDurationMin: 30,
    elapsedMinutes: 20, // faster than quoted
    freeAllowanceMinutes: 20,
    perMinuteNaira: 100,
    fareNaira: 4000,
  });
  assert.strictEqual(result.overageNaira, 0);
  assert.strictEqual(result.delayMinutes, 0);
});

test("a ride with no quoted duration (e.g. a charter) never produces an overage", () => {
  const result = computeFairFareOverageNaira({
    quotedDurationMin: null,
    elapsedMinutes: 500,
    freeAllowanceMinutes: 20,
    perMinuteNaira: 100,
    fareNaira: 4000,
  });
  assert.strictEqual(result.overageNaira, 0);
});

test("overage is capped at 2x the original fare, however extreme the delay", () => {
  const result = computeFairFareOverageNaira({
    quotedDurationMin: 10,
    elapsedMinutes: 10000, // absurd delay
    freeAllowanceMinutes: 15,
    perMinuteNaira: 100,
    fareNaira: 4000,
  });
  assert.strictEqual(result.overageNaira, 8000); // 2x fareNaira cap
});

test("zero free allowance still works (a candidate value under consideration)", () => {
  const result = computeFairFareOverageNaira({
    quotedDurationMin: 30,
    elapsedMinutes: 35,
    freeAllowanceMinutes: 0,
    perMinuteNaira: 50,
    fareNaira: 4000,
  });
  assert.strictEqual(result.billableMinutes, 5);
  assert.strictEqual(result.overageNaira, 250);
});

// ── Arrivo Express Phase 2 — launch promo windows ──

test("4:30am Lagos time is the start of Early Bird (inclusive)", () => {
  assert.strictEqual(activeLaunchPromo(lagosTime(4, 30)), "early_bird");
});

test("4:29am Lagos time is not yet Early Bird", () => {
  assert.strictEqual(activeLaunchPromo(lagosTime(4, 29)), null);
});

test("6:59am Lagos time is still Early Bird", () => {
  assert.strictEqual(activeLaunchPromo(lagosTime(6, 59)), "early_bird");
});

test("exactly 7:00am Lagos time is Morning Commuter, not Early Bird (boundary is exclusive/inclusive)", () => {
  assert.strictEqual(activeLaunchPromo(lagosTime(7, 0)), "morning_commuter");
});

test("8:59am Lagos time is still Morning Commuter", () => {
  assert.strictEqual(activeLaunchPromo(lagosTime(8, 59)), "morning_commuter");
});

test("9:00am Lagos time is outside every promo window", () => {
  assert.strictEqual(activeLaunchPromo(lagosTime(9, 0)), null);
});

test("2pm Lagos time (outside all windows) gets no promo", () => {
  assert.strictEqual(activeLaunchPromo(lagosTime(14, 0)), null);
});

test("applyLaunchPromoDiscount halves the fare during Early Bird at the brief's 50%", () => {
  const result = applyLaunchPromoDiscount({
    fareNaira: 4000,
    date: lagosTime(5, 0),
    earlyBirdPercent: 50,
    morningCommuterPercent: 20,
  });
  assert.strictEqual(result.promo, "early_bird");
  assert.strictEqual(result.fareNaira, 2000);
  assert.strictEqual(result.originalFareNaira, 4000);
  assert.strictEqual(result.discountPercent, 50);
});

test("applyLaunchPromoDiscount takes 20% off during Morning Commuter", () => {
  const result = applyLaunchPromoDiscount({
    fareNaira: 4000,
    date: lagosTime(8, 0),
    earlyBirdPercent: 50,
    morningCommuterPercent: 20,
  });
  assert.strictEqual(result.promo, "morning_commuter");
  assert.strictEqual(result.fareNaira, 3200);
});

test("applyLaunchPromoDiscount leaves the fare untouched outside any window", () => {
  const result = applyLaunchPromoDiscount({
    fareNaira: 4000,
    date: lagosTime(14, 0),
    earlyBirdPercent: 50,
    morningCommuterPercent: 20,
  });
  assert.strictEqual(result.promo, null);
  assert.strictEqual(result.fareNaira, 4000);
});

test("applyLaunchPromoDiscount is a no-op if the configured percent is 0 (promo effectively off)", () => {
  const result = applyLaunchPromoDiscount({
    fareNaira: 4000,
    date: lagosTime(5, 0),
    earlyBirdPercent: 0,
    morningCommuterPercent: 20,
  });
  assert.strictEqual(result.promo, null);
  assert.strictEqual(result.fareNaira, 4000);
});

test("isLuckyRideWindow is true at 12:30pm Lagos time and false right at 1:00pm", () => {
  assert.strictEqual(isLuckyRideWindow(lagosTime(12, 30)), true);
  assert.strictEqual(isLuckyRideWindow(lagosTime(13, 0)), false);
});

test("lagosDateString reflects the Lagos calendar day, not the UTC one, near midnight", () => {
  // 11:30pm UTC on Jan 1 is 12:30am Lagos time on Jan 2.
  const almostMidnightUtc = new Date(Date.UTC(2026, 0, 1, 23, 30));
  assert.strictEqual(lagosDateString(almostMidnightUtc), "2026-01-02");
});

console.log(`${passed} passed`);
