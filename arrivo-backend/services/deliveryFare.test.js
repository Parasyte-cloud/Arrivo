// Tests for the ArrivoExpress Delivery fare engine. Uses Node's built-in
// assert, matching services/instantFare.test.js's convention. Run with:
//   node services/deliveryFare.test.js

const assert = require("assert");
const { computeDeliveryFare, DeliveryFareError } = require("./deliveryFare");

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

test("bicycle fare scales with distance and time", () => {
  const short = computeDeliveryFare({
    vehicleTier: "bicycle",
    packageSize: "envelope",
    pickupAddress: "Ikeja GRA",
    destinationAddress: "Maryland",
    distanceKm: 2,
    durationMin: 8,
  });

  const long = computeDeliveryFare({
    vehicleTier: "bicycle",
    packageSize: "envelope",
    pickupAddress: "Ikeja GRA",
    destinationAddress: "Maryland",
    distanceKm: 8,
    durationMin: 25,
  });

  assert.ok(long.fareNaira > short.fareNaira, "a longer delivery must cost more");
});

test("unknown vehicle tier is rejected", () => {
  assert.throws(
    () =>
      computeDeliveryFare({
        vehicleTier: "truck",
        packageSize: "envelope",
        pickupAddress: "Ikeja GRA",
        destinationAddress: "Maryland",
        distanceKm: 5,
        durationMin: 15,
      }),
    DeliveryFareError
  );
});

test("unknown package size is rejected", () => {
  assert.throws(
    () =>
      computeDeliveryFare({
        vehicleTier: "bicycle",
        packageSize: "fridge",
        pickupAddress: "Ikeja GRA",
        destinationAddress: "Maryland",
        distanceKm: 5,
        durationMin: 15,
      }),
    DeliveryFareError
  );
});

test("a medium/large package can't go by bicycle", () => {
  assert.throws(
    () =>
      computeDeliveryFare({
        vehicleTier: "bicycle",
        packageSize: "medium",
        pickupAddress: "Ikeja GRA",
        destinationAddress: "Maryland",
        distanceKm: 5,
        durationMin: 15,
      }),
    (err) => err instanceof DeliveryFareError && err.code === "PACKAGE_TOO_BIG_FOR_VEHICLE"
  );
});

test("a medium package by motorcycle is fine and costs more than an envelope", () => {
  const trip = {
    pickupAddress: "Ikeja GRA",
    destinationAddress: "Maryland",
    distanceKm: 6,
    durationMin: 18,
  };

  const envelope = computeDeliveryFare({ vehicleTier: "motorcycle", packageSize: "envelope", ...trip });
  const medium = computeDeliveryFare({ vehicleTier: "motorcycle", packageSize: "medium", ...trip });

  assert.ok(medium.fareNaira > envelope.fareNaira, "a bigger package should cost more via the package surcharge");
});

test("excluded (red zone) area is rejected", () => {
  assert.throws(
    () =>
      computeDeliveryFare({
        vehicleTier: "motorcycle",
        packageSize: "small",
        pickupAddress: "Ikeja GRA",
        destinationAddress: "Badagry",
        distanceKm: 40,
        durationMin: 90,
      }),
    DeliveryFareError
  );
});

test("yellow zone corridor costs more than an equivalent green zone trip", () => {
  const green = computeDeliveryFare({
    vehicleTier: "motorcycle",
    packageSize: "small",
    pickupAddress: "Ikeja GRA",
    destinationAddress: "Maryland",
    distanceKm: 8,
    durationMin: 20,
  });

  const yellow = computeDeliveryFare({
    vehicleTier: "motorcycle",
    packageSize: "small",
    pickupAddress: "Ikeja GRA",
    destinationAddress: "Lekki",
    distanceKm: 8,
    durationMin: 20,
  });

  assert.ok(yellow.fareNaira > green.fareNaira, "yellow zone delivery should cost more than an identical green zone delivery");
  assert.strictEqual(yellow.zone, "yellow");
  assert.strictEqual(green.zone, "green");
});

test("a very short delivery is floored at the vehicle's minimum fare", () => {
  const quote = computeDeliveryFare({
    vehicleTier: "bicycle",
    packageSize: "envelope",
    pickupAddress: "Ikeja GRA",
    destinationAddress: "Maryland",
    distanceKm: 0.3,
    durationMin: 2,
  });

  assert.strictEqual(quote.breakdown.minimumApplied, true);
  assert.ok(quote.fareNaira >= quote.breakdown.minimumFareNaira);
});

test("motorcycle quotes higher than bicycle for the same envelope trip", () => {
  const trip = {
    packageSize: "envelope",
    pickupAddress: "Ikeja GRA",
    destinationAddress: "Maryland",
    distanceKm: 10,
    durationMin: 25,
  };

  const bicycle = computeDeliveryFare({ vehicleTier: "bicycle", ...trip });
  const motorcycle = computeDeliveryFare({ vehicleTier: "motorcycle", ...trip });

  assert.ok(motorcycle.fareNaira > bicycle.fareNaira);
});

console.log(`${passed} test(s) passed`);
