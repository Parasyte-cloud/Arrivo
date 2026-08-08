// Tests for the phase 2 additions: route intent classification,
// telemetry validation, and route recalculation logic. Run directly:
//   node services/phase2.test.js

const assert = require("assert");
const { classifyRouteIntent } = require("./routeDeviation");
const { validateTelemetry } = require("./telemetryValidation");
const { isRecalcEligible, evaluateAndPossiblyReroute } = require("./routeService");
const { FakeRoutingProvider } = require("./routing/FakeRoutingProvider");

let passed = 0;
function test(name, fn) {
  return (async () => {
    try {
      await fn();
      console.log(`  ok  ${name}`);
      passed++;
    } catch (e) {
      console.log(`FAIL  ${name}`);
      console.log(`      ${e.message}`);
      process.exitCode = 1;
    }
  })();
}

(async () => {

console.log("Route intent classification (spec section 4/17):");

await test("valid alternate route: off-route but distance-to-destination consistently decreasing", () => {
  const r = classifyRouteIntent({
    deviationState: "OFF_ROUTE",
    recentDestinationDistancesKm: [5.0, 4.6, 4.2, 3.9],
  });
  assert.strictEqual(r.intent, "VALID_ALTERNATIVE");
});

await test("temporary deviation: off-route, distance trend flat/ambiguous", () => {
  const r = classifyRouteIntent({
    deviationState: "OFF_ROUTE",
    recentDestinationDistancesKm: [5.0, 5.05, 4.97, 5.02],
  });
  assert.strictEqual(r.intent, "TEMPORARY_DEVIATION");
});

await test("vehicle moving toward destination while off original route is NOT flagged suspicious", () => {
  const r = classifyRouteIntent({
    deviationState: "PERSISTENT_OFF_ROUTE",
    recentDestinationDistancesKm: [6.0, 5.4, 4.8, 4.1],
  });
  assert.notStrictEqual(r.intent, "SUSPICIOUS");
  assert.notStrictEqual(r.intent, "CRITICAL");
});

await test("suspicious: persistently off-route AND consistently moving away from destination", () => {
  const r = classifyRouteIntent({
    deviationState: "PERSISTENT_OFF_ROUTE",
    recentDestinationDistancesKm: [3.0, 3.3, 3.6, 3.9],
  });
  assert.strictEqual(r.intent, "SUSPICIOUS");
});

await test("critical: off-route, moving away, AND already in CRITICAL_ROUTE_DEVIATION state", () => {
  const r = classifyRouteIntent({
    deviationState: "CRITICAL_ROUTE_DEVIATION",
    recentDestinationDistancesKm: [3.0, 3.4, 3.8, 4.3],
  });
  assert.strictEqual(r.intent, "CRITICAL");
});

await test("a single U-turn sample inside an otherwise-approaching trend does not flip the classification", () => {
  const r = classifyRouteIntent({
    deviationState: "OFF_ROUTE",
    recentDestinationDistancesKm: [5.0, 4.6, 4.9, 4.0], // one noisy uptick, overall clearly decreasing
  });
  assert.strictEqual(r.intent, "VALID_ALTERNATIVE");
});

await test("insufficient data returns INSUFFICIENT_DATA, not a false conclusion", () => {
  const r = classifyRouteIntent({ deviationState: "OFF_ROUTE", recentDestinationDistancesKm: [5.0, 4.8] });
  assert.strictEqual(r.intent, "INSUFFICIENT_DATA");
});

console.log("\nTelemetry validation (spec section 4, 17):");

await test("GPS jump: impossible speed between two samples is rejected", () => {
  const r = validateTelemetry({
    sample: { lat: 9.0765, lng: 7.3986, recordedAt: "2026-01-01T00:00:05Z" }, // Abuja
    previousSample: { lat: 6.5244, lng: 3.3792, recordedAt: "2026-01-01T00:00:00Z" }, // Lagos, 5s earlier
    now: new Date("2026-01-01T00:00:06Z"),
  });
  assert.strictEqual(r.valid, false);
  assert.strictEqual(r.classification, "IMPOSSIBLE_JUMP");
});

await test("stale telemetry (over an hour old) is rejected", () => {
  const r = validateTelemetry({
    sample: { lat: 6.5244, lng: 3.3792, recordedAt: "2026-01-01T00:00:00Z" },
    previousSample: null,
    now: new Date("2026-01-01T02:00:00Z"),
  });
  assert.strictEqual(r.valid, false);
  assert.strictEqual(r.classification, "TIMESTAMP_TOO_OLD");
});

await test("out-of-order telemetry (older than the last accepted sample) is rejected", () => {
  const r = validateTelemetry({
    sample: { lat: 6.5244, lng: 3.3792, recordedAt: "2026-01-01T00:00:00Z" },
    previousSample: { lat: 6.5244, lng: 3.3792, recordedAt: "2026-01-01T00:00:10Z" },
    now: new Date("2026-01-01T00:00:11Z"),
  });
  assert.strictEqual(r.valid, false);
  assert.strictEqual(r.classification, "OUT_OF_ORDER");
});

await test("exact duplicate telemetry is rejected", () => {
  const r = validateTelemetry({
    sample: { lat: 6.5244, lng: 3.3792, recordedAt: "2026-01-01T00:00:10Z" },
    previousSample: { lat: 6.5244, lng: 3.3792, recordedAt: "2026-01-01T00:00:10Z" },
    now: new Date("2026-01-01T00:00:11Z"),
  });
  assert.strictEqual(r.valid, false);
  assert.strictEqual(r.classification, "DUPLICATE");
});

await test("normal, plausible consecutive samples are accepted", () => {
  const r = validateTelemetry({
    sample: { lat: 6.5254, lng: 3.3792, recordedAt: "2026-01-01T00:00:20Z" },
    previousSample: { lat: 6.5244, lng: 3.3792, recordedAt: "2026-01-01T00:00:00Z" },
    now: new Date("2026-01-01T00:00:21Z"),
  });
  assert.strictEqual(r.valid, true);
});

await test("invalid coordinates (out of lat/lng range) are rejected", () => {
  const r = validateTelemetry({
    sample: { lat: 200, lng: 3.3792, recordedAt: "2026-01-01T00:00:00Z" },
    previousSample: null,
    now: new Date("2026-01-01T00:00:01Z"),
  });
  assert.strictEqual(r.valid, false);
  assert.strictEqual(r.classification, "INVALID_COORDINATES");
});

console.log("\nRoute recalculation cooldown (spec section 2, 19):");

await test("recalc is eligible when no previous route exists", () => {
  assert.strictEqual(isRecalcEligible({ lastRouteGeneratedAt: null }), true);
});

await test("recalc is blocked inside the cooldown window", () => {
  const now = new Date("2026-01-01T00:02:00Z");
  const lastRouteGeneratedAt = "2026-01-01T00:01:00Z"; // 60s ago, cooldown is 90s
  assert.strictEqual(isRecalcEligible({ lastRouteGeneratedAt, now }), false);
});

await test("recalc is eligible once the cooldown window has passed", () => {
  const now = new Date("2026-01-01T00:03:00Z");
  const lastRouteGeneratedAt = "2026-01-01T00:01:00Z"; // 120s ago, cooldown is 90s
  assert.strictEqual(isRecalcEligible({ lastRouteGeneratedAt, now }), true);
});

console.log("\nRouting provider failure handling (spec section 18):");

await test("provider failure during reroute does not throw, and reports providerUnavailable", async () => {
  const db = { query: async () => {} };
  const failingProvider = new FakeRoutingProvider({ shouldFail: true, retryable: true });
  const result = await evaluateAndPossiblyReroute({
    db, routingProvider: failingProvider, rideId: 1,
    intentResult: { intent: "VALID_ALTERNATIVE", reason: "test" },
    currentVehiclePosition: { lat: 6.52, lng: 3.37 }, destination: { lat: 6.55, lng: 3.4 },
    lastRouteGeneratedAt: null, currentRouteVersion: 1,
  });
  assert.strictEqual(result.rerouted, false);
  assert.strictEqual(result.providerUnavailable, true);
  assert.strictEqual(result.retryable, true);
});

await test("intent other than VALID_ALTERNATIVE never triggers a reroute call", async () => {
  let called = false;
  const provider = { getRoute: async () => { called = true; } };
  const db = { query: async () => {} };
  await evaluateAndPossiblyReroute({
    db, routingProvider: provider, rideId: 1,
    intentResult: { intent: "SUSPICIOUS", reason: "test" },
    currentVehiclePosition: { lat: 6.52, lng: 3.37 }, destination: { lat: 6.55, lng: 3.4 },
    lastRouteGeneratedAt: null, currentRouteVersion: 1,
  });
  assert.strictEqual(called, false);
});

await test("successful reroute increments the route version and writes a timeline event", async () => {
  const queries = [];
  const db = { query: async (sql, params) => { queries.push({ sql, params }); } };
  const provider = new FakeRoutingProvider();
  const result = await evaluateAndPossiblyReroute({
    db, routingProvider: provider, rideId: 42,
    intentResult: { intent: "VALID_ALTERNATIVE", reason: "test reroute" },
    currentVehiclePosition: { lat: 6.52, lng: 3.37 }, destination: { lat: 6.55, lng: 3.4 },
    lastRouteGeneratedAt: null, currentRouteVersion: 1,
  });
  assert.strictEqual(result.rerouted, true);
  assert.strictEqual(result.newVersion, 2);
  assert.strictEqual(queries.length, 2); // one UPDATE, one timeline INSERT
});

console.log(`\n${passed} passed`);
})();
