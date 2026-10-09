// Tests for the optional On the Go fields. Run directly:
//   node services/onTheGoRequest.test.js

const assert = require("assert");
const { parseOptionalExtras, MAX_DETAILS_LENGTH, MAX_SERVICE_LENGTH, MAX_ADVANCE_DAYS, PAST_GRACE_MS } = require("./onTheGoRequest");

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

const NOW = new Date("2026-10-09T12:00:00Z").getTime();
const HOUR = 3600 * 1000;
const iso = (offsetMs) => new Date(NOW + offsetMs).toISOString();

console.log("On the Go optional fields:");

test("a request from an older app build (no extras) is accepted unchanged", () => {
  assert.deepStrictEqual(parseOptionalExtras({}, NOW), { value: { requestedPickupAt: null, details: null, service: null } });
  assert.deepStrictEqual(parseOptionalExtras(undefined, NOW).value.requestedPickupAt, null);
});

test("blank strings count as not sent", () => {
  const r = parseOptionalExtras({ requestedPickupAt: "", details: "", service: "" }, NOW);
  assert.deepStrictEqual(r.value, { requestedPickupAt: null, details: null, service: null });
});

test("a future pickup time is stored as ISO", () => {
  const r = parseOptionalExtras({ requestedPickupAt: iso(5 * HOUR) }, NOW);
  assert.strictEqual(r.value.requestedPickupAt, iso(5 * HOUR));
});

test("an offset timestamp is normalised", () => {
  const r = parseOptionalExtras({ requestedPickupAt: "2026-10-09T18:00:00+01:00" }, NOW);
  assert.strictEqual(r.value.requestedPickupAt, "2026-10-09T17:00:00.000Z");
});

test("garbage and non-string times are rejected", () => {
  assert.ok(parseOptionalExtras({ requestedPickupAt: "soon" }, NOW).error);
  assert.ok(parseOptionalExtras({ requestedPickupAt: 12345 }, NOW).error);
  assert.ok(parseOptionalExtras({ requestedPickupAt: {} }, NOW).error);
});

test("past times are rejected, with a few minutes of grace", () => {
  assert.ok(parseOptionalExtras({ requestedPickupAt: iso(-PAST_GRACE_MS - 60000) }, NOW).error);
  assert.ok(!parseOptionalExtras({ requestedPickupAt: iso(-60000) }, NOW).error);
});

test("far-future times are rejected", () => {
  const day = 24 * HOUR;
  assert.ok(parseOptionalExtras({ requestedPickupAt: iso((MAX_ADVANCE_DAYS + 1) * day) }, NOW).error);
  assert.ok(!parseOptionalExtras({ requestedPickupAt: iso((MAX_ADVANCE_DAYS - 1) * day) }, NOW).error);
});

test("details and service are trimmed and length limited", () => {
  assert.strictEqual(parseOptionalExtras({ details: "  Two bags  " }, NOW).value.details, "Two bags");
  assert.ok(parseOptionalExtras({ details: "x".repeat(MAX_DETAILS_LENGTH + 1) }, NOW).error);
  assert.ok(!parseOptionalExtras({ details: "x".repeat(MAX_DETAILS_LENGTH) }, NOW).error);
  assert.ok(parseOptionalExtras({ service: "y".repeat(MAX_SERVICE_LENGTH + 1) }, NOW).error);
  assert.strictEqual(parseOptionalExtras({ service: " Chauffeur " }, NOW).value.service, "Chauffeur");
});

test("whitespace-only details become null", () => {
  assert.strictEqual(parseOptionalExtras({ details: "   " }, NOW).value.details, null);
});

console.log(`\n${passed} passed`);
