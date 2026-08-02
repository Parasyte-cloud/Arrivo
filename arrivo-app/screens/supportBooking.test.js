// Tests for which booking a support ticket attaches to. Run directly:
//   node screens/supportBooking.test.js
//
// Two things to know about the setup. It tests supportBooking.js rather than
// the screen because the screen imports react-native, which won't load
// outside Metro. And it compiles that module before requiring it: app source
// is ESM, this package is CommonJS to node, so node can't require the ESM
// file directly. Babel is already here as an Expo dependency, so this needs
// nothing new installed.

const assert = require("assert");
const path = require("path");
const babel = require("@babel/core");

const { code } = babel.transformFileSync(path.join(__dirname, "supportBooking.js"), {
  babelrc: false,
  configFile: false,
  plugins: [require.resolve("@babel/plugin-transform-modules-commonjs")],
});
const mod = { exports: {} };
new Function("module", "exports", "require", code)(mod, mod.exports, require);
const { pickBooking, describeRide, ACTIVE_STATUSES } = mod.exports;

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

// /api/rides/mine comes back newest first, so these are in that order.
const ride = (id, ride_status, extra = {}) => ({
  id,
  ride_status,
  pickup_address: `Pickup ${id}`,
  stops: [`Dest ${id}`],
  created_at: "2026-08-01T10:00:00Z",
  ...extra,
});

console.log("Picking the booking to attach:");

test("a live trip wins over a newer finished one", () => {
  const rides = [ride(3, "completed"), ride(2, "in_progress"), ride(1, "completed")];
  assert.strictEqual(pickBooking(rides).id, 2);
});

test("with nothing live, the most recent booking is used", () => {
  const rides = [ride(3, "completed"), ride(2, "cancelled")];
  assert.strictEqual(pickBooking(rides).id, 3);
});

test("the newest live trip wins when several are live", () => {
  const rides = [ride(5, "accepted"), ride(4, "requested")];
  assert.strictEqual(pickBooking(rides).id, 5);
});

test("every active status counts as live", () => {
  for (const status of ACTIVE_STATUSES) {
    const rides = [ride(9, "completed"), ride(8, status)];
    assert.strictEqual(pickBooking(rides).id, 8, `${status} was not treated as live`);
  }
});

test("a cancelled trip is history, not live", () => {
  assert.ok(!ACTIVE_STATUSES.includes("cancelled"));
  const rides = [ride(2, "completed"), ride(1, "cancelled")];
  // Falls through to the newest as a fallback, not because anything is live.
  assert.strictEqual(pickBooking(rides).id, 2);
});

test("a rider who has never booked gets nothing to attach", () => {
  assert.strictEqual(pickBooking([]), null);
});

test("a missing or malformed list is handled, not thrown on", () => {
  assert.strictEqual(pickBooking(undefined), null);
  assert.strictEqual(pickBooking(null), null);
});

console.log("\nDescribing it:");

test("route reads pickup to destination, with the date", () => {
  const out = describeRide(ride(1, "completed"));
  assert.ok(out.startsWith("Pickup 1 to Dest 1"), out);
  assert.ok(out.includes("·"), out);
});

test("the last stop is the destination", () => {
  const out = describeRide(ride(1, "completed", { stops: ["Middle", "Final"] }));
  assert.ok(out.startsWith("Pickup 1 to Final"), out);
});

test("blank stops are ignored", () => {
  const out = describeRide(ride(1, "completed", { stops: [null, "", "Real Dest"] }));
  assert.ok(out.startsWith("Pickup 1 to Real Dest"), out);
});

test("with no stops at all it's just the pickup", () => {
  const out = describeRide(ride(1, "completed", { stops: [] }));
  assert.ok(out.startsWith("Pickup 1"), out);
  assert.ok(!out.includes(" to "), out);
});

test("stops that never parsed into an array don't throw", () => {
  const out = describeRide(ride(1, "completed", { stops: undefined }));
  assert.ok(out.startsWith("Pickup 1"), out);
});

test("no created_at means no date suffix", () => {
  const out = describeRide(ride(1, "completed", { created_at: null }));
  assert.strictEqual(out, "Pickup 1 to Dest 1");
});

console.log(`\n${passed} passed`);
