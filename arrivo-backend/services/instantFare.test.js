// Tests for the ArrivoExpress metered fare engine. Uses Node's built-in assert
// — no new test framework dependency, matching the convention already
// established by services/routeDeviation.test.js. Run directly with:
//   node services/instantFare.test.js

const assert = require("assert");
const { computeInstantFare, InstantFareError } = require("./instantFare");

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

test("economy fare scales with distance and time", () => {
  const short = computeInstantFare({
    tier: "economy",
    pickupAddress: "Ikeja GRA",
    destinationAddress: "Maryland",
    distanceKm: 3,
    durationMin: 10,
  });

  const long = computeInstantFare({
    tier: "economy",
    pickupAddress: "Ikeja GRA",
    destinationAddress: "Maryland",
    distanceKm: 15,
    durationMin: 40,
  });

  assert.ok(long.fareNaira > short.fareNaira, "a longer trip must cost more");
});

test("unknown tier is rejected", () => {
  assert.throws(
    () =>
      computeInstantFare({
        tier: "business-class",
        pickupAddress: "Ikeja GRA",
        destinationAddress: "Maryland",
        distanceKm: 5,
        durationMin: 15,
      }),
    InstantFareError
  );
});

test("excluded (red zone) area is rejected", () => {
  assert.throws(
    () =>
      computeInstantFare({
        tier: "economy",
        pickupAddress: "Ikeja GRA",
        destinationAddress: "Badagry",
        distanceKm: 40,
        durationMin: 90,
      }),
    InstantFareError
  );
});

test("yellow zone corridor costs more than an equivalent green zone trip", () => {
  const green = computeInstantFare({
    tier: "economy",
    pickupAddress: "Ikeja GRA",
    destinationAddress: "Maryland",
    distanceKm: 8,
    durationMin: 20,
  });

  const yellow = computeInstantFare({
    tier: "economy",
    pickupAddress: "Ikeja GRA",
    destinationAddress: "Lekki",
    distanceKm: 8,
    durationMin: 20,
  });

  assert.ok(yellow.fareNaira > green.fareNaira, "yellow zone trip should cost more than an identical green zone trip");
  assert.strictEqual(yellow.zone, "yellow");
  assert.strictEqual(green.zone, "green");
});

test("a very short trip is floored at the tier minimum fare", () => {
  const quote = computeInstantFare({
    tier: "economy",
    pickupAddress: "Ikeja GRA",
    destinationAddress: "Maryland",
    distanceKm: 0.2,
    durationMin: 1,
  });

  assert.strictEqual(quote.breakdown.minimumApplied, true);
  assert.ok(quote.fareNaira >= quote.breakdown.minimumFareNaira);
});

test("XL and Premium both quote higher than Economy for the same trip", () => {
  const trip = {
    pickupAddress: "Ikeja GRA",
    destinationAddress: "Maryland",
    distanceKm: 10,
    durationMin: 25,
  };

  const economy = computeInstantFare({ tier: "economy", ...trip });
  const xl = computeInstantFare({ tier: "xl", ...trip });
  const premium = computeInstantFare({ tier: "premium", ...trip });

  assert.ok(xl.fareNaira > economy.fareNaira);
  assert.ok(premium.fareNaira > xl.fareNaira);
});

console.log(`${passed} test(s) passed`);
