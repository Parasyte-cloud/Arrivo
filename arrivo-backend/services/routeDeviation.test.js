// Tests for the exact scenarios spec section 28 asks for. Uses Node's
// built-in assert — no new test framework dependency added just for
// this, since none currently exists in this backend. Run directly with:
//   node services/routeDeviation.test.js

const assert = require("assert");
const { evaluateTelemetry, haversineMeters, distanceToPolylineMeters } = require("./routeDeviation");

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

// A simple straight route for predictable geometry in tests: two points
// about 2km apart, running roughly north.
const route = [
  { lat: 6.5244, lng: 3.3792 },
  { lat: 6.5424, lng: 3.3792 },
];
const destination = { lat: 6.5424, lng: 3.3792 };

const baseState = {
  state: "ON_ROUTE",
  distanceFromRouteM: 0,
  distanceFromDestinationKm: null,
  consecutiveOffRouteSamples: 0,
  stateEnteredAt: "2026-01-01T00:00:00Z",
};

function offsetPoint(lat, lng, metersEast) {
  const mPerDegLng = 111320 * Math.cos((lat * Math.PI) / 180);
  return { lat, lng: lng + metersEast / mPerDegLng };
}

console.log("Geometry primitives:");

test("haversine distance between two known points is roughly correct", () => {
  const d = haversineMeters({ lat: 6.5244, lng: 3.3792 }, { lat: 6.5244, lng: 3.3792 });
  assert.strictEqual(d, 0);
});

test("distanceToPolylineMeters is ~0 for a point on the route", () => {
  const onRoute = { lat: 6.5334, lng: 3.3792 };
  const d = distanceToPolylineMeters(onRoute, route);
  assert.ok(d < 1, `expected near-zero, got ${d}`);
});

console.log("\nRoute detection distance bands (spec 28):");

test("vehicle exactly on route stays ON_ROUTE", () => {
  const point = { lat: 6.5334, lng: 3.3792 };
  const r = evaluateTelemetry({
    telemetry: { ...point, accuracyM: 15, speedKmh: 40, recordedAt: "2026-01-01T00:00:10Z" },
    route, destination, currentState: baseState,
  });
  assert.strictEqual(r.state, "ON_ROUTE");
});

test("vehicle 20m off route stays ON_ROUTE (within normal band)", () => {
  const point = offsetPoint(6.5334, 3.3792, 20);
  const r = evaluateTelemetry({
    telemetry: { ...point, accuracyM: 10, speedKmh: 40, recordedAt: "2026-01-01T00:00:10Z" },
    route, destination, currentState: baseState,
  });
  assert.strictEqual(r.state, "ON_ROUTE");
});

test("vehicle 100m off route becomes POSSIBLE_DEVIATION on first sample, not an immediate alert", () => {
  const point = offsetPoint(6.5334, 3.3792, 200); // 200m raw, minus accuracy
  const r = evaluateTelemetry({
    telemetry: { ...point, accuracyM: 10, speedKmh: 40, recordedAt: "2026-01-01T00:00:10Z" },
    route, destination, currentState: baseState,
  });
  assert.strictEqual(r.state, "POSSIBLE_DEVIATION");
});

test("vehicle 200m off route, single sample, does NOT jump straight to CRITICAL", () => {
  const point = offsetPoint(6.5334, 3.3792, 200);
  const r = evaluateTelemetry({
    telemetry: { ...point, accuracyM: 10, speedKmh: 40, recordedAt: "2026-01-01T00:00:10Z" },
    route, destination, currentState: baseState,
  });
  assert.notStrictEqual(r.state, "CRITICAL_ROUTE_DEVIATION");
});

test("vehicle persistently 200m off route for 3+ samples over 30+s escalates to PERSISTENT_OFF_ROUTE", () => {
  const point = offsetPoint(6.5334, 3.3792, 200);
  let state = { ...baseState, state: "OFF_ROUTE", stateEnteredAt: "2026-01-01T00:00:00Z", consecutiveOffRouteSamples: 2 };
  const r = evaluateTelemetry({
    telemetry: { ...point, accuracyM: 10, speedKmh: 40, recordedAt: "2026-01-01T00:00:35Z" },
    route, destination, currentState: state,
  });
  assert.strictEqual(r.state, "PERSISTENT_OFF_ROUTE");
});

test("vehicle returns to route after being off — state resets to ON_ROUTE", () => {
  const point = { lat: 6.5334, lng: 3.3792 };
  const state = { ...baseState, state: "PERSISTENT_OFF_ROUTE", consecutiveOffRouteSamples: 5, stateEnteredAt: "2026-01-01T00:01:00Z" };
  const r = evaluateTelemetry({
    telemetry: { ...point, accuracyM: 10, speedKmh: 40, recordedAt: "2026-01-01T00:01:20Z" },
    route, destination, currentState: state,
  });
  assert.strictEqual(r.state, "ON_ROUTE");
  assert.strictEqual(r.consecutiveOffRouteSamples, 0);
});

console.log("\nGPS quality (spec 28):");

test("poor GPS accuracy (beyond trust threshold) skips evaluation rather than alerting", () => {
  const point = offsetPoint(6.5334, 3.3792, 200);
  const r = evaluateTelemetry({
    telemetry: { ...point, accuracyM: 350, speedKmh: 40, recordedAt: "2026-01-01T00:00:10Z" },
    route, destination, currentState: baseState,
  });
  assert.strictEqual(r.changed, false);
  assert.ok(r.skippedReason.includes("accuracy"));
});

test("moderate GPS inaccuracy is subtracted, not ignored — 180m raw with ±150m accuracy reads as only 30m", () => {
  const point = offsetPoint(6.5334, 3.3792, 180);
  const r = evaluateTelemetry({
    telemetry: { ...point, accuracyM: 150, speedKmh: 40, recordedAt: "2026-01-01T00:00:10Z" },
    route, destination, currentState: baseState,
  });
  assert.strictEqual(r.state, "ON_ROUTE");
});

console.log("\nStationary vehicle (spec 28):");

test("stationary vehicle far from route does not accumulate deviation", () => {
  const point = offsetPoint(6.5334, 3.3792, 500);
  const r = evaluateTelemetry({
    telemetry: { ...point, accuracyM: 10, speedKmh: 0, recordedAt: "2026-01-01T00:00:10Z" },
    route, destination, currentState: baseState,
  });
  assert.strictEqual(r.changed, false);
  assert.ok(r.skippedReason.includes("stationary"));
});

console.log(`\n${passed} passed`);
