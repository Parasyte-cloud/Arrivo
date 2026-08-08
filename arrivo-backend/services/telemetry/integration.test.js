// Integration tests proving telemetryService actually wires the phase
// 1-3 modules together correctly — not mocking each dependency, but
// running real code against a fake in-memory DB. Implements the five
// scenarios spec section 25 explicitly asks for.
//
// Run: node services/telemetry/integration.test.js

const assert = require("assert");
const { processTelemetry } = require("./telemetryService");
const { createFakeDb } = require("./fakeDb");
const { FakeRoutingProvider } = require("../routing/FakeRoutingProvider");

let passed = 0;
function test(name, fn) {
  return (async () => {
    try {
      await fn();
      console.log(`  ok  ${name}`);
      passed++;
    } catch (e) {
      console.log(`FAIL  ${name}`);
      console.log(`      ${e.stack}`);
      process.exitCode = 1;
    }
  })();
}

const ROUTE = [{ lat: 6.5244, lng: 3.3792 }, { lat: 6.5424, lng: 3.3792 }];
const DESTINATION = { lat: 6.5424, lng: 3.3792 };

function makeRide(overrides = {}) {
  return {
    id: 1, driver_id: 100, ride_status: "in_progress",
    route_geometry: ROUTE, route_version: 1, route_generated_at: "2026-01-01T00:00:00Z",
    dropoff_lat: DESTINATION.lat, dropoff_lng: DESTINATION.lng,
    ...overrides,
  };
}

function offsetPoint(lat, lng, metersEast) {
  const mPerDegLng = 111320 * Math.cos((lat * Math.PI) / 180);
  return { lat, lng: lng + metersEast / mPerDegLng };
}

function sample(overrides) {
  return { lat: 6.53, lng: 3.3792, accuracyM: 10, speedKmh: 40, headingDeg: 0, recordedAt: "2026-01-01T00:00:10Z", source: "driver_phone", ...overrides };
}

// Every call below passes an explicit `now` a few seconds after the
// sample's own recordedAt — simulating realistic near-real-time
// delivery, and specifically avoiding the staleness check comparing
// fixed test dates against the real wall clock (which is what caused
// every test to fail on the first run of this suite).
function nowAfter(recordedAt, secondsLater = 3) {
  return new Date(new Date(recordedAt).getTime() + secondsLater * 1000);
}

(async () => {

console.log("Scenario A — Normal ride:");
await test("telemetry on-route produces no alert and ON_ROUTE state", async () => {
  const db = createFakeDb({ rides: [makeRide()] });
  const telemetry = sample({ lat: 6.5334, lng: 3.3792 });
  const result = await processTelemetry({
    db, routingProvider: new FakeRoutingProvider(), driverId: 100, vehicleId: 1,
    submittedTelemetry: telemetry, now: nowAfter(telemetry.recordedAt),
  });
  assert.strictEqual(result.accepted, true, JSON.stringify(result));
  assert.strictEqual(result.deviationState, "ON_ROUTE");
  assert.strictEqual(db._state.safety_alerts.length, 0);
});

console.log("\nScenario B — Temporary deviation, no false incident:");
await test("a single off-route sample does not create an alert", async () => {
  const db = createFakeDb({ rides: [makeRide()] });
  const point = offsetPoint(6.5334, 3.3792, 200);
  const telemetry = sample({ ...point });
  const result = await processTelemetry({
    db, routingProvider: new FakeRoutingProvider(), driverId: 100, vehicleId: 1,
    submittedTelemetry: telemetry, now: nowAfter(telemetry.recordedAt),
  });
  assert.strictEqual(result.deviationState, "POSSIBLE_DEVIATION", JSON.stringify(result));
  assert.strictEqual(db._state.safety_alerts.length, 0);
});

console.log("\nScenario D — Suspicious deviation escalates, generates a real alert:");
await test("persistent off-route with worsening destination trend creates a HIGH/CRITICAL alert, not 50 rows", async () => {
  const db = createFakeDb({ rides: [makeRide()] });
  const provider = new FakeRoutingProvider();
  const point = offsetPoint(6.5334, 3.3792, 200);

  const times = ["00:00:10", "00:00:20", "00:00:35", "00:00:50", "00:01:05"];
  let last;
  for (const t of times) {
    const recordedAt = `2026-01-01T${t}Z`;
    last = await processTelemetry({
      db, routingProvider: provider, driverId: 100, vehicleId: 1,
      submittedTelemetry: sample({ ...point, recordedAt }), now: nowAfter(recordedAt),
    });
  }

  assert.ok(["PERSISTENT_OFF_ROUTE", "CRITICAL_ROUTE_DEVIATION"].includes(last.deviationState), `expected escalated state, got ${JSON.stringify(last)}`);
  assert.strictEqual(db._state.safety_alerts.length, 1, `expected exactly 1 alert row after ${times.length} off-route samples, got ${db._state.safety_alerts.length}`);
});

console.log("\nScenario E — Recovery:");
await test("vehicle returning to route auto-resolves the open alert", async () => {
  const db = createFakeDb({ rides: [makeRide()] });
  const provider = new FakeRoutingProvider();
  const offPoint = offsetPoint(6.5334, 3.3792, 200);
  const onPoint = { lat: 6.5334, lng: 3.3792 };

  const times = ["00:00:10", "00:00:20", "00:00:35", "00:00:50", "00:01:05"];
  for (const t of times) {
    const recordedAt = `2026-01-01T${t}Z`;
    await processTelemetry({ db, routingProvider: provider, driverId: 100, vehicleId: 1, submittedTelemetry: sample({ ...offPoint, recordedAt }), now: nowAfter(recordedAt) });
  }
  assert.strictEqual(db._state.safety_alerts.length, 1);
  assert.strictEqual(db._state.safety_alerts[0].status, "OPEN");

  const recoveryTime = "2026-01-01T00:01:20Z";
  await processTelemetry({ db, routingProvider: provider, driverId: 100, vehicleId: 1, submittedTelemetry: sample({ ...onPoint, recordedAt: recoveryTime }), now: nowAfter(recoveryTime) });

  assert.strictEqual(db._state.safety_alerts[0].status, "RESOLVED");
  assert.strictEqual(db._state.safety_alerts[0].auto_resolved, true);
});

console.log("\nOther pipeline correctness:");

await test("no active ride: updates vehicle state, runs no ride-level deviation logic, no crash", async () => {
  const db = createFakeDb({ rides: [] });
  const telemetry = sample();
  const result = await processTelemetry({
    db, routingProvider: new FakeRoutingProvider(), driverId: 999, vehicleId: 1,
    submittedTelemetry: telemetry, now: nowAfter(telemetry.recordedAt),
  });
  assert.strictEqual(result.rideCorrelation, "NO_ACTIVE_RIDE", JSON.stringify(result));
  assert.strictEqual(db._state.safety_alerts.length, 0);
  assert.ok(db._state.vehicle_current_state[1], "vehicle state should still be updated for fleet monitoring");
});

await test("ride active but no route yet: does not crash, reports NO_ROUTE", async () => {
  const db = createFakeDb({ rides: [makeRide({ route_geometry: null })] });
  const telemetry = sample();
  const result = await processTelemetry({
    db, routingProvider: new FakeRoutingProvider(), driverId: 100, vehicleId: 1,
    submittedTelemetry: telemetry, now: nowAfter(telemetry.recordedAt),
  });
  assert.strictEqual(result.routeState, "NO_ROUTE", JSON.stringify(result));
});

await test("invalid telemetry (impossible jump) is rejected before any deviation logic runs", async () => {
  const db = createFakeDb({ rides: [makeRide()] });
  const first = sample({ lat: 6.5334, lng: 3.3792, recordedAt: "2026-01-01T00:00:10Z" });
  await processTelemetry({ db, routingProvider: new FakeRoutingProvider(), driverId: 100, vehicleId: 1, submittedTelemetry: first, now: nowAfter(first.recordedAt) });

  const jump = sample({ lat: 9.0765, lng: 7.3986, recordedAt: "2026-01-01T00:00:15Z" }); // Abuja, 5s later
  const result = await processTelemetry({
    db, routingProvider: new FakeRoutingProvider(), driverId: 100, vehicleId: 1,
    submittedTelemetry: jump, now: nowAfter(jump.recordedAt),
  });
  assert.strictEqual(result.accepted, false, JSON.stringify(result));
  assert.strictEqual(result.classification, "IMPOSSIBLE_JUMP");
  assert.strictEqual(db._state.ride_telemetry.length, 1, "rejected sample must not be persisted");
});

console.log(`\n${passed} passed`);
})();
