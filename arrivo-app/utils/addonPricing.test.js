// Tests for the add-on price labels. Run directly:
//   node utils/addonPricing.test.js
//
// Loads the module without a bundler: it is plain data and pure functions with
// no imports, so stripping the export keywords and evaluating it is enough.
//
// The part that matters most is the last block. These constants are a second
// copy of what arrivo-backend/services/fare.js actually charges, so the test
// reads the backend file and fails if they drift. A price on screen that does
// not match the one charged is worse than showing no price at all, which is
// what this whole change set out to fix.

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "addonPricing.js");
const src = fs.readFileSync(SRC, "utf8");
assert.ok(!/^\s*import\s/m.test(src), "addonPricing.js has to stay import-free for this test to load it");

const load = new Function(
  src.replace(/^export const /gm, "const ").replace(/^export function /gm, "function ") +
    "\nreturn { SECURITY_ESCORT_USD, FLEET_PRICE_NAIRA, FLEET_SIZES, securityEscortPrice, securityEscortDescription, fleetPrice, fleetChipLabel, fleetDescription };"
);
const {
  SECURITY_ESCORT_USD, FLEET_PRICE_NAIRA, FLEET_SIZES,
  securityEscortPrice, securityEscortDescription, fleetPrice, fleetChipLabel, fleetDescription,
} = load();

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

// Stand-in for the app's formatFare, which turns naira into a display string.
const formatFare = (naira) => `₦${Math.round(naira).toLocaleString("en-NG")}`;

console.log("Security escort:");

test("converts to naira once a quote has landed", () => {
  assert.strictEqual(securityEscortPrice(1600, formatFare), "₦160,000");
});

test("falls back to dollars before a quote arrives", () => {
  assert.strictEqual(securityEscortPrice(null, formatFare), "$100");
  assert.strictEqual(securityEscortPrice(undefined, formatFare), "$100");
  assert.strictEqual(securityEscortPrice(0, formatFare), "$100");
});

test("the description carries the price, not just a vague line", () => {
  const d = securityEscortDescription(1600, formatFare);
  assert.ok(d.includes("₦160,000"), d);
  assert.ok(/security vehicle/i.test(d), d);
});

console.log("");
console.log("Fleet accompaniment:");

test("each size prices in naira with no rate needed", () => {
  assert.strictEqual(fleetPrice(2, formatFare), "₦70,000");
  assert.strictEqual(fleetPrice(3, formatFare), "₦100,000");
});

test("none has no price", () => {
  assert.strictEqual(fleetPrice(0, formatFare), null);
});

test("the chip shows the price without having to select it first", () => {
  assert.strictEqual(fleetChipLabel(0, formatFare), "None");
  assert.ok(fleetChipLabel(2, formatFare).includes("₦70,000"), fleetChipLabel(2, formatFare));
  assert.ok(fleetChipLabel(3, formatFare).includes("₦100,000"));
});

test("every offered size has a price, so no chip can render undefined", () => {
  for (const size of FLEET_SIZES) {
    const label = fleetChipLabel(size, formatFare);
    assert.ok(!/undefined|null|NaN/.test(label), `size ${size} produced "${label}"`);
  }
});

test("the description follows the current choice", () => {
  assert.ok(!/₦/.test(fleetDescription(0, formatFare)), "none should not quote a price");
  assert.ok(fleetDescription(3, formatFare).includes("₦100,000"));
});

console.log("");
console.log("No em dashes, per the copy rule:");

test("nothing a rider reads carries one", () => {
  const copy = [
    securityEscortDescription(1600, formatFare),
    securityEscortDescription(null, formatFare),
    ...FLEET_SIZES.map((n) => fleetChipLabel(n, formatFare)),
    ...FLEET_SIZES.map((n) => fleetDescription(n, formatFare)),
  ].join(" ");
  assert.ok(!/[–—]/.test(copy), copy);
});

console.log("");
console.log("These match what the backend actually charges:");

// Reading the real file rather than trusting a comment. If someone reprices an
// add-on server-side and forgets this copy, riders get quoted the old number.
const fareSrc = fs.readFileSync(
  path.join(__dirname, "..", "..", "arrivo-backend", "services", "fare.js"),
  "utf8"
);

test("security escort matches SECURITY_ESCORT_PRICE_USD", () => {
  const m = /SECURITY_ESCORT_PRICE_USD\s*=\s*(\d+)/.exec(fareSrc);
  assert.ok(m, "could not find SECURITY_ESCORT_PRICE_USD in the backend");
  assert.strictEqual(Number(m[1]), SECURITY_ESCORT_USD, "escort price has drifted from the backend");
});

test("fleet prices match FLEET_PRICE_NAIRA", () => {
  const m = /FLEET_PRICE_NAIRA\s*=\s*\{([^}]*)\}/.exec(fareSrc);
  assert.ok(m, "could not find FLEET_PRICE_NAIRA in the backend");
  const backend = {};
  for (const pair of m[1].split(",")) {
    const kv = /(\d+)\s*:\s*(\d+)/.exec(pair);
    if (kv) backend[kv[1]] = Number(kv[2]);
  }
  assert.deepStrictEqual(
    Object.fromEntries(Object.entries(FLEET_PRICE_NAIRA).map(([k, v]) => [k, v])),
    backend,
    "fleet prices have drifted from the backend"
  );
});

test("every size the app offers is one the backend prices", () => {
  for (const size of FLEET_SIZES) {
    if (size === 0) continue;
    assert.ok(FLEET_PRICE_NAIRA[size], `size ${size} is offered with no price behind it`);
  }
});

console.log(`\n${passed} passed`);
