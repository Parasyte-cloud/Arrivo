// Tests for the booking config served to the apps. Run directly:
//   node services/bookingConfig.test.js

const assert = require("assert");
const { buildBookingConfig, DEFAULT_SUPPORT } = require("./bookingConfig");
const { ON_THE_GO_ONLY_HOURS, STANDARD_MIN_HOURS } = require("./bookingWindow");
const { readClient } = require("./appVersion");

let passed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
    passed++;
  } catch (e) {
    console.log(`FAIL  ${name}\n      ${e.message}`);
    process.exitCode = 1;
  }
}

const NOW = Date.UTC(2026, 9, 9, 12, 0);

console.log("Booking config:");
test("with nothing configured it serves the current rules and contacts", () => {
  const c = buildBookingConfig({}, null, NOW);
  assert.strictEqual(c.minHours, ON_THE_GO_ONLY_HOURS);
  assert.strictEqual(c.standardMinHours, STANDARD_MIN_HOURS);
  assert.strictEqual(c.maxAdvanceDays, null);
  assert.deepStrictEqual(c.support, {
    phone: DEFAULT_SUPPORT.phone,
    phoneDisplay: DEFAULT_SUPPORT.phoneDisplay,
    whatsapp: "2348162706078",
    email: DEFAULT_SUPPORT.email,
  });
  assert.strictEqual(c.app, null);
  assert.strictEqual(c.serverTime, "2026-10-09T12:00:00.000Z");
});
test("the hours come from the same constants the booking routes enforce", () => {
  assert.strictEqual(buildBookingConfig({}).minHours, require("./bookingWindow").ON_THE_GO_ONLY_HOURS);
});
test("max advance days accepts a sane whole number only", () => {
  assert.strictEqual(buildBookingConfig({ BOOKING_MAX_ADVANCE_DAYS: "90" }).maxAdvanceDays, 90);
  for (const bad of ["0", "-3", "abc", "1.5", "99999", ""]) {
    assert.strictEqual(buildBookingConfig({ BOOKING_MAX_ADVANCE_DAYS: bad }).maxAdvanceDays, null, bad);
  }
});
test("support overrides apply and bad ones fall back to the defaults", () => {
  const c = buildBookingConfig({ SUPPORT_PHONE: "+2348011112222", SUPPORT_PHONE_DISPLAY: "+234 801 111 2222", SUPPORT_EMAIL: "help@ridearrivo.com" });
  assert.strictEqual(c.support.phone, "+2348011112222");
  assert.strictEqual(c.support.whatsapp, "2348011112222");
  assert.strictEqual(c.support.phoneDisplay, "+234 801 111 2222");
  assert.strictEqual(c.support.email, "help@ridearrivo.com");
  const bad = buildBookingConfig({ SUPPORT_PHONE: "call me", SUPPORT_EMAIL: "nope" });
  assert.strictEqual(bad.support.phone, DEFAULT_SUPPORT.phone);
  assert.strictEqual(bad.support.email, DEFAULT_SUPPORT.email);
});
test("a caller that sent version headers gets its own minimum and store link", () => {
  const client = readClient({ "x-app-name": "rider", "x-app-version": "1.0.0", "x-app-platform": "android" });
  const c = buildBookingConfig({ MIN_APP_VERSION_RIDER: "1.3.0", MIN_APP_VERSION_DRIVER: "5.0.0" }, client);
  assert.strictEqual(c.app.minVersion, "1.3.0");
  assert.ok(c.app.storeUrl.includes("com.arrivo.app"));
});
test("no private or environment data leaks into the response", () => {
  const text = JSON.stringify(buildBookingConfig({ DATABASE_URL: "postgres://secret", JWT_SECRET: "s3cret" }));
  assert.ok(!text.includes("secret") && !text.includes("postgres"));
});

console.log(`\n${passed} passed`);
