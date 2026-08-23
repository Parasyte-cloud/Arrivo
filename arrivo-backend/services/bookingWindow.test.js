// Boundary tests for the booking window rule. Run directly:
//   node services/bookingWindow.test.js
//
// Time is pinned by passing `now` explicitly rather than leaning on the
// clock, so these do the same thing at 3am as at noon.

const assert = require("assert");
const {
  STANDARD_MIN_HOURS,
  ON_THE_GO_ONLY_HOURS,
  hoursUntil,
  bookingWindow,
  isStandardBookingBlocked,
  blockedBookingResponse,
} = require("./bookingWindow");

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

const NOW = new Date("2026-08-23T12:00:00Z").getTime();
const at = (hoursFromNow) => new Date(NOW + hoursFromNow * 60 * 60 * 1000);

console.log("The three bands:");

test("72h out books normally", () => {
  assert.strictEqual(bookingWindow(at(72), NOW), "standard");
});

test("exactly 48h out books normally", () => {
  assert.strictEqual(bookingWindow(at(STANDARD_MIN_HOURS), NOW), "standard");
});

test("a minute under 48h falls into the open gap, not blocked", () => {
  assert.strictEqual(bookingWindow(at(48 - 1 / 60), NOW), "gap");
});

test("24h out is in the gap band", () => {
  assert.strictEqual(bookingWindow(at(24), NOW), "gap");
});

test("exactly 12h out is still allowed", () => {
  assert.strictEqual(bookingWindow(at(ON_THE_GO_ONLY_HOURS), NOW), "gap");
});

test("a minute under 12h is On the Go only", () => {
  assert.strictEqual(bookingWindow(at(12 - 1 / 60), NOW), "on_the_go_only");
});

test("2h out is On the Go only", () => {
  assert.strictEqual(bookingWindow(at(2), NOW), "on_the_go_only");
});

test("right now is On the Go only", () => {
  assert.strictEqual(bookingWindow(at(0), NOW), "on_the_go_only");
});

test("a date in the past is On the Go only", () => {
  assert.strictEqual(bookingWindow(at(-5), NOW), "on_the_go_only");
});

console.log("\nNothing to judge means don't stand in the way:");

// This is the airport-pickup case. Those are timed off the flight and never
// carry a date here, and new Date(null) is epoch 0, which is finite. Without
// the null guard every airport pickup reads as decades overdue and gets
// blocked, which would take out the busiest booking path in the product.
test("null is treated as standard, not as epoch 0", () => {
  assert.strictEqual(hoursUntil(null, NOW), null);
  assert.strictEqual(bookingWindow(null, NOW), "standard");
  assert.strictEqual(isStandardBookingBlocked(null, NOW), false);
});

test("undefined is treated as standard", () => {
  assert.strictEqual(bookingWindow(undefined, NOW), "standard");
  assert.strictEqual(isStandardBookingBlocked(undefined, NOW), false);
});

test("empty string is treated as standard", () => {
  assert.strictEqual(bookingWindow("", NOW), "standard");
});

test("an unparseable date is treated as standard rather than blocking", () => {
  assert.strictEqual(hoursUntil("not-a-date", NOW), null);
  assert.strictEqual(bookingWindow("not-a-date", NOW), "standard");
});

console.log("\nAccepts what the route actually passes it:");

test("a Date object and its ISO string agree", () => {
  const when = at(6);
  assert.strictEqual(bookingWindow(when, NOW), bookingWindow(when.toISOString(), NOW));
});

test("hoursUntil measures in hours", () => {
  assert.strictEqual(hoursUntil(at(6), NOW), 6);
  assert.strictEqual(hoursUntil(at(-3), NOW), -3);
});

console.log("\nisStandardBookingBlocked only blocks the bottom band:");

test("blocks under 12h and nothing above it", () => {
  assert.strictEqual(isStandardBookingBlocked(at(72), NOW), false);
  assert.strictEqual(isStandardBookingBlocked(at(48), NOW), false);
  assert.strictEqual(isStandardBookingBlocked(at(24), NOW), false);
  assert.strictEqual(isStandardBookingBlocked(at(12), NOW), false);
  assert.strictEqual(isStandardBookingBlocked(at(11), NOW), true);
  assert.strictEqual(isStandardBookingBlocked(at(-1), NOW), true);
});

console.log("\nA blocked rider is never left at a dead end:");

test("the response offers On the Go and a human, not just an error", () => {
  const body = blockedBookingResponse();
  assert.ok(body.error && body.error.length > 0, "no message");
  assert.strictEqual(body.blockedByBookingWindow, true);
  assert.strictEqual(body.onTheGoAvailable, true);
  assert.ok(/^\+\d{6,}$/.test(body.whatsappNumber), `whatsapp number looks wrong: ${body.whatsappNumber}`);
});

test("the message says how much notice is needed", () => {
  assert.ok(
    blockedBookingResponse().error.includes(String(ON_THE_GO_ONLY_HOURS)),
    "the message should name the number of hours needed"
  );
});

console.log("\nThe two copies of the rule agree:");

// The app greys the button out using its own copy of these constants. If the
// two drift, the app lets someone submit a booking the API then refuses,
// which is exactly the dead end the brief rules out.
test("app and backend constants are identical", () => {
  const fs = require("fs");
  const path = require("path");
  const appSrc = fs.readFileSync(
    path.join(__dirname, "..", "..", "arrivo-app", "utils", "bookingWindow.js"),
    "utf8"
  );
  const appStandard = /STANDARD_MIN_HOURS\s*=\s*(\d+)/.exec(appSrc);
  const appOnTheGo = /ON_THE_GO_ONLY_HOURS\s*=\s*(\d+)/.exec(appSrc);
  assert.ok(appStandard && appOnTheGo, "could not read the app's constants");
  assert.strictEqual(Number(appStandard[1]), STANDARD_MIN_HOURS, "STANDARD_MIN_HOURS has drifted");
  assert.strictEqual(Number(appOnTheGo[1]), ON_THE_GO_ONLY_HOURS, "ON_THE_GO_ONLY_HOURS has drifted");
});

console.log(`\n${passed} passed`);
