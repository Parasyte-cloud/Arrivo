// Tests for Arrivo Fair Fare's overage calculation (services/fare.js
// computeFairFareOverageNaira). Hand-rolled test runner, matching the
// convention already established by services/instantFare.test.js — no new
// test framework dependency. Run directly with:
//   node services/fare.test.js

const assert = require("assert");
const { computeFairFareOverageNaira } = require("./fare");

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

console.log(`${passed} passed`);
