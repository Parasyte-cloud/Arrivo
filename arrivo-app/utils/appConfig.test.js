// Tests for the config-driven pieces: booking rules, support contacts and the
// update-required state. Run directly:
//   node utils/appConfig.test.js
//
// Each module is import-free, so it is evaluated without a bundler.

const assert = require("assert");
const fs = require("fs");
const path = require("path");

function load(file, returns) {
  const src = fs.readFileSync(path.join(__dirname, file), "utf8");
  assert.ok(!/^\s*import\s/m.test(src), `${file} has to stay import-free for this test to load it`);
  assert.ok(!src.includes(String.fromCharCode(0x2014)), `no em dash in ${file}`);
  return new Function(
    src.replace(/^export const /gm, "const ").replace(/^export function /gm, "function ") + `\nreturn { ${returns} };`
  )();
}

const W = load(
  "bookingWindow.js",
  "STANDARD_MIN_HOURS, ON_THE_GO_ONLY_HOURS, getBookingRules, setBookingRulesFromConfig, resetBookingRules, bookingWindow, isStandardBookingBlocked, earliestStandardBooking"
);
const S = load("supportContacts.js", "getSupportContacts, whatsappUrl, setSupportContactsFromConfig, resetSupportContacts");
const U = load("updateRequired.js", "parseUpdateRequired, getUpdateRequired, subscribeUpdateRequired, noteResponse");

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
const hours = (h) => new Date(NOW + h * 3600 * 1000);

console.log("Booking rules from config:");
test("with no config the bundled constants apply", () => {
  W.resetBookingRules();
  assert.deepStrictEqual(W.getBookingRules(), { standardMinHours: 48, onTheGoOnlyHours: 12, maxAdvanceDays: null });
  assert.strictEqual(W.isStandardBookingBlocked(hours(11.9), NOW), true);
  assert.strictEqual(W.isStandardBookingBlocked(hours(12), NOW), false);
});
test("a config with a longer notice moves the blocking line", () => {
  W.resetBookingRules();
  W.setBookingRulesFromConfig({ minHours: 24, standardMinHours: 48, maxAdvanceDays: 90 });
  assert.strictEqual(W.isStandardBookingBlocked(hours(20), NOW), true);
  assert.strictEqual(W.isStandardBookingBlocked(hours(24), NOW), false);
  assert.strictEqual(W.bookingWindow(hours(30), NOW), "gap");
  assert.strictEqual(W.getBookingRules().maxAdvanceDays, 90);
  assert.strictEqual(W.earliestStandardBooking(NOW).getTime(), NOW + 24 * 3600 * 1000);
  W.resetBookingRules();
});
test("bad fields are ignored one by one", () => {
  W.resetBookingRules();
  W.setBookingRulesFromConfig({ minHours: "soon", standardMinHours: 72, maxAdvanceDays: -4 });
  assert.deepStrictEqual(W.getBookingRules(), { standardMinHours: 72, onTheGoOnlyHours: 12, maxAdvanceDays: null });
  W.setBookingRulesFromConfig({ minHours: 0 });
  W.setBookingRulesFromConfig({ minHours: 5000 });
  W.setBookingRulesFromConfig({ minHours: 6.5 });
  assert.strictEqual(W.getBookingRules().onTheGoOnlyHours, 12);
  W.resetBookingRules();
});
test("garbage config never changes anything", () => {
  W.resetBookingRules();
  for (const junk of [null, undefined, "x", 5, [], {}]) W.setBookingRulesFromConfig(junk);
  assert.deepStrictEqual(W.getBookingRules(), { standardMinHours: 48, onTheGoOnlyHours: 12, maxAdvanceDays: null });
});
test("a config that contradicts itself is refused whole", () => {
  W.resetBookingRules();
  W.setBookingRulesFromConfig({ minHours: 60, standardMinHours: 24 });
  assert.deepStrictEqual(W.getBookingRules(), { standardMinHours: 48, onTheGoOnlyHours: 12, maxAdvanceDays: null });
});
test("maxAdvanceDays null clears an earlier limit", () => {
  W.resetBookingRules();
  W.setBookingRulesFromConfig({ maxAdvanceDays: 60 });
  assert.strictEqual(W.getBookingRules().maxAdvanceDays, 60);
  W.setBookingRulesFromConfig({ maxAdvanceDays: null });
  assert.strictEqual(W.getBookingRules().maxAdvanceDays, null);
  W.resetBookingRules();
});

console.log("\nSupport contacts:");
test("defaults are the current support details", () => {
  S.resetSupportContacts();
  assert.deepStrictEqual(S.getSupportContacts(), { phone: "+2348162706078", phoneDisplay: "+234 816 270 6078", email: "info@ridearrivo.com" });
  assert.strictEqual(S.whatsappUrl(), "https://wa.me/2348162706078");
});
test("whatsappUrl encodes a message", () => {
  assert.strictEqual(S.whatsappUrl("Hi there\nPickup: Lekki"), "https://wa.me/2348162706078?text=Hi%20there%0APickup%3A%20Lekki");
});
test("config replaces valid fields and keeps the rest", () => {
  S.resetSupportContacts();
  S.setSupportContactsFromConfig({ phone: "+2348011112222", phoneDisplay: "+234 801 111 2222", email: "help@ridearrivo.com" });
  assert.strictEqual(S.getSupportContacts().phone, "+2348011112222");
  assert.strictEqual(S.whatsappUrl(), "https://wa.me/2348011112222");
  S.setSupportContactsFromConfig({ phone: "not a number", email: "bad" });
  assert.strictEqual(S.getSupportContacts().phone, "+2348011112222");
  assert.strictEqual(S.getSupportContacts().email, "help@ridearrivo.com");
  S.resetSupportContacts();
});
test("a new phone without a display string shows the number itself, not the old display", () => {
  S.resetSupportContacts();
  S.setSupportContactsFromConfig({ phone: "+2348033334444" });
  assert.strictEqual(S.getSupportContacts().phoneDisplay, "+2348033334444");
  S.resetSupportContacts();
});

console.log("\nUpdate required:");
const body = { error: "Please update.", code: "app_update_required", minVersion: "1.2.0", storeUrl: "https://play.google.com/store/apps/details?id=com.arrivo.app" };
test("only a real 426 with the code counts", () => {
  assert.ok(U.parseUpdateRequired(426, body));
  assert.strictEqual(U.parseUpdateRequired(426, { error: "x" }), null);
  assert.strictEqual(U.parseUpdateRequired(500, body), null);
  assert.strictEqual(U.parseUpdateRequired(200, body), null);
  assert.strictEqual(U.parseUpdateRequired(426, null), null);
});
test("a store link that is not https is dropped", () => {
  assert.strictEqual(U.parseUpdateRequired(426, { ...body, storeUrl: "javascript:alert(1)" }).storeUrl, null);
  assert.strictEqual(U.parseUpdateRequired(426, { ...body, storeUrl: "http://example.com" }).storeUrl, null);
  assert.strictEqual(U.parseUpdateRequired(426, { ...body, storeUrl: 5 }).storeUrl, null);
});
test("noteResponse ignores ordinary responses", () => {
  U.noteResponse(200, {});
  U.noteResponse(401, { error: "no" });
  assert.strictEqual(U.getUpdateRequired(), null);
});
test("noteResponse records the update and tells listeners", () => {
  let calls = 0;
  const off = U.subscribeUpdateRequired(() => { calls += 1; });
  U.noteResponse(426, body);
  assert.strictEqual(calls, 1);
  assert.strictEqual(U.getUpdateRequired().minVersion, "1.2.0");
  off();
  U.noteResponse(426, body);
  assert.strictEqual(calls, 1);
});

console.log("\nParity with the backend:");
test("bundled hour constants still match the backend's", () => {
  const backend = require(path.join(__dirname, "..", "..", "arrivo-backend", "services", "bookingWindow.js"));
  assert.strictEqual(W.STANDARD_MIN_HOURS, backend.STANDARD_MIN_HOURS);
  assert.strictEqual(W.ON_THE_GO_ONLY_HOURS, backend.ON_THE_GO_ONLY_HOURS);
});
// The backend's config service ships on feat/app-config-backend. Until that is
// merged this branch cannot see it, so the check is skipped rather than failed.
const backendConfig = path.join(__dirname, "..", "..", "arrivo-backend", "services", "bookingConfig.js");
if (fs.existsSync(backendConfig)) {
  test("bundled support contacts match the backend's defaults", () => {
    const { DEFAULT_SUPPORT } = require(backendConfig);
    S.resetSupportContacts();
    assert.deepStrictEqual(S.getSupportContacts(), DEFAULT_SUPPORT);
  });
} else {
  console.log("  skip  bundled support contacts vs backend defaults (backend config service not on this branch)");
}

console.log(`\n${passed} passed`);
