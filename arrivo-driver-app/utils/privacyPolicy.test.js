// Guards the privacy copy shown at signup. Run directly:
//   node utils/privacyPolicy.test.js
//
// Loads the module without a bundler and without any dependency: it is plain
// data with no imports, so stripping the export keywords and evaluating it is
// enough. This app has no node_modules checked out, so the test deliberately
// leans on nothing but node itself.
//
// The point of these checks is that the disclosures are legal copy. Drivers
// hand over more than riders do, and the always-on location line in
// particular would be easy to lose in a later edit and hard to spot.

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "privacyPolicy.js"), "utf8");
assert.ok(!/^\s*import\s/m.test(src), "privacyPolicy.js has to stay import-free for this test to load it");

const load = new Function(
  src.replace(/^export const /gm, "const ") +
    "\nreturn { PRIVACY_LAST_UPDATED, PRIVACY_FULL_URL, PRIVACY_SECTIONS };"
);
const { PRIVACY_LAST_UPDATED, PRIVACY_FULL_URL, PRIVACY_SECTIONS } = load();

const allCopy = [
  PRIVACY_LAST_UPDATED,
  PRIVACY_FULL_URL,
  ...PRIVACY_SECTIONS.map((s) => `${s.title} ${s.body}`),
].join("\n");

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

console.log("Shape:");

test("every section has a title and a body", () => {
  assert.ok(PRIVACY_SECTIONS.length > 0, "no sections at all");
  for (const section of PRIVACY_SECTIONS) {
    assert.strictEqual(typeof section.title, "string");
    assert.strictEqual(typeof section.body, "string");
    assert.ok(section.title.trim().length > 0, "a section has a blank title");
    assert.ok(section.body.trim().length > 20, `section "${section.title}" has a stub body`);
  }
});

test("section titles are unique, since they key the list", () => {
  const titles = PRIVACY_SECTIONS.map((s) => s.title);
  assert.strictEqual(new Set(titles).size, titles.length);
});

console.log("\nHouse copy rule:");

test("no em or en dashes anywhere in the copy", () => {
  const offenders = PRIVACY_SECTIONS.filter((s) => /[–—]/.test(`${s.title} ${s.body}`));
  assert.strictEqual(offenders.length, 0, `found one in: ${offenders.map((s) => s.title).join(", ")}`);
});

console.log("\nDisclosures that have to survive future edits:");

const required = [
  ["precise GPS location", /precise GPS location/i],
  ["what happens to data after deletion", /7 years/i],
  ["the payment processor by name", /Paystack/i],
  ["the flight data provider by name", /AviationStack/i],
  ["that data is not sold", /do not sell/i],
  ["the legal threshold for police disclosure", /court order/i],
  ["storage outside Nigeria", /outside Nigeria/i],
  ["the data protection contact", /privacy@ridearrivo\.com/i],
  ["the governing law", /NDPA/],
  ["the regulator to complain to", /Nigeria Data Protection Commission/i],
  ["the minimum age", /18/],
];

for (const [label, pattern] of required) {
  test(`states ${label}`, () => {
    assert.ok(pattern.test(allCopy), `nothing in the copy matches ${pattern}`);
  });
}

console.log("\nDriver specifics:");

test("covers the documents drivers hand over", () => {
  assert.ok(/LASDRI/i.test(allCopy), "LASDRI number not mentioned");
  assert.ok(/license number/i.test(allCopy), "license number not mentioned");
  assert.ok(/insurance/i.test(allCopy), "insurance documents not mentioned");
  assert.ok(/payout/i.test(allCopy), "payout details not mentioned");
});

test("says location is collected the whole time they are online", () => {
  assert.ok(/while you are online/i.test(allCopy), "always-on location not disclosed");
  assert.ok(/not only during a trip/i.test(allCopy), "does not make the always-on scope explicit");
});

console.log("\nPointers:");

test("points at the full policy on the website", () => {
  assert.match(PRIVACY_FULL_URL, /ridearrivo\.com\/privacy/);
});

test("carries the date of the policy it summarises", () => {
  assert.strictEqual(PRIVACY_LAST_UPDATED, "August 22, 2026");
});

console.log(`\n${passed} passed`);
