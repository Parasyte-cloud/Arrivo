// Tests for Arrivo Express Phase 3 (Arrivo Share capacity, Grotto x
// RideArrivo area-lock radius). Run directly:
//   node services/arrivoExpressPhase3.test.js
const assert = require("assert");
const { hasRoomForAnotherShareParticipant, MAX_PASSENGERS } = require("./fare");
const { isWithinRadiusKm } = require("./routeDeviation");

let passed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
    passed++;
  } catch (e) {
    console.log(`FAIL  ${name}`);
    console.log(`      ${e.message}`);
    process.exitCode = 1;
  }
}

console.log("Arrivo Share -- vehicle capacity (MAX_PASSENGERS: " + JSON.stringify(MAX_PASSENGERS) + "):");

test("sedan (capacity 3): organizer alone, room for 1 more co-rider", () => {
  assert.strictEqual(hasRoomForAnotherShareParticipant("sedan", 0), true);
});
test("sedan (capacity 3): organizer + 1 co-rider, room for exactly 1 more", () => {
  assert.strictEqual(hasRoomForAnotherShareParticipant("sedan", 1), true);
});
test("sedan (capacity 3): organizer + 2 co-riders is already full", () => {
  assert.strictEqual(hasRoomForAnotherShareParticipant("sedan", 2), false);
});
test("suv (capacity 5): organizer + 3 co-riders, room for 1 more (the brief's 'maximum of 5')", () => {
  assert.strictEqual(hasRoomForAnotherShareParticipant("suv", 3), true);
});
test("suv (capacity 5): organizer + 4 co-riders is already full", () => {
  assert.strictEqual(hasRoomForAnotherShareParticipant("suv", 4), false);
});
test("truck (capacity 5) matches suv's cap", () => {
  assert.strictEqual(hasRoomForAnotherShareParticipant("truck", 3), true);
  assert.strictEqual(hasRoomForAnotherShareParticipant("truck", 4), false);
});
test("unknown vehicle type defaults to capacity 1 (organizer only, no co-riders)", () => {
  assert.strictEqual(hasRoomForAnotherShareParticipant("helicopter", 0), false);
});

console.log("\nGrotto x RideArrivo -- area-lock radius:");

const VENUE = { lat: 6.4281, lng: 3.4219 }; // Lekki Phase 1, roughly
const NEARBY_PICKUP = { lat: 6.4310, lng: 3.4250 }; // a few hundred meters away
const FAR_PICKUP = { lat: 6.5833, lng: 3.3500 }; // Ikeja, ~20km+ away

test("a pickup a few hundred meters from the venue is within a 5km radius", () => {
  assert.strictEqual(isWithinRadiusKm(VENUE, NEARBY_PICKUP, 5), true);
});
test("a pickup ~20km away is NOT within a 5km radius", () => {
  assert.strictEqual(isWithinRadiusKm(VENUE, FAR_PICKUP, 5), false);
});
test("the same far pickup IS within a generously large radius", () => {
  assert.strictEqual(isWithinRadiusKm(VENUE, FAR_PICKUP, 50), true);
});
test("a ride missing pickup coordinates fails closed (excluded, never guessed at)", () => {
  assert.strictEqual(isWithinRadiusKm(VENUE, { lat: null, lng: null }, 5), false);
});
test("a missing venue also fails closed", () => {
  assert.strictEqual(isWithinRadiusKm(null, NEARBY_PICKUP, 5), false);
});

console.log(`\n${passed} passed`);
