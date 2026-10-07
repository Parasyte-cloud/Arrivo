// Tests for the vehicle-picker availability estimate. Pure functions only, so
// no database is needed:  node services/instantNearby.test.js

const assert = require("assert");
const { summarizeNearby, etaMinutesForDistance } = require("./instantNearby");

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

const tiers = [
  { key: "economy", vehicleType: "sedan", minSeats: 1 },
  { key: "comfort", vehicleType: "suv", minSeats: 1 },
  { key: "xl", vehicleType: "suv", minSeats: 6 },
  { key: "premium", vehicleType: "truck", minSeats: 1 },
];

test("eta is never under 2 minutes", () => {
  assert.strictEqual(etaMinutesForDistance(0), 2);
  assert.strictEqual(etaMinutesForDistance(0.1), 2);
});

test("eta grows with distance (20 km/h default plus 1 minute)", () => {
  delete process.env.ARRIVO_NOW_ETA_SPEED_KMH;
  assert.strictEqual(etaMinutesForDistance(5), 16); // 15 + 1
});

test("eta rejects nonsense distances", () => {
  assert.strictEqual(etaMinutesForDistance(-1), null);
  assert.strictEqual(etaMinutesForDistance("abc"), null);
});

test("an out-of-range speed override is ignored", () => {
  process.env.ARRIVO_NOW_ETA_SPEED_KMH = "9999";
  assert.strictEqual(etaMinutesForDistance(5), 16);
  delete process.env.ARRIVO_NOW_ETA_SPEED_KMH;
});

test("counts drivers per tier and reports the nearest one's eta", () => {
  const out = summarizeNearby(
    [
      { vehicle_type: "sedan", seats: 4, distance_to_pickup_km: 2 },
      { vehicle_type: "sedan", seats: 4, distance_to_pickup_km: 6 },
      { vehicle_type: "suv", seats: 7, distance_to_pickup_km: 4 },
    ],
    tiers
  );
  assert.deepStrictEqual(out.economy, { drivers: 2, etaMin: etaMinutesForDistance(2) });
  assert.strictEqual(out.comfort.drivers, 1);
  assert.strictEqual(out.premium.drivers, 0);
  assert.strictEqual(out.premium.etaMin, null);
});

test("XL only counts SUVs with enough seats", () => {
  const out = summarizeNearby(
    [
      { vehicle_type: "suv", seats: 4, distance_to_pickup_km: 1 },
      { vehicle_type: "suv", seats: 7, distance_to_pickup_km: 3 },
    ],
    tiers
  );
  assert.strictEqual(out.comfort.drivers, 2);
  assert.strictEqual(out.xl.drivers, 1);
  assert.strictEqual(out.xl.etaMin, etaMinutesForDistance(3));
});

test("no drivers anywhere gives zero and null for every tier", () => {
  const out = summarizeNearby([], tiers);
  for (const k of Object.keys(out)) {
    assert.deepStrictEqual(out[k], { drivers: 0, etaMin: null });
  }
});

console.log(`${passed} passed`);
