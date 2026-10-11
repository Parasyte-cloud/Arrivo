// Guards the privacy copy shown at signup. Run directly:
//   node utils/privacyPolicy.test.js
//
// Loads the module without a bundler and without any dependency: it is plain
// data with no imports, so stripping the export keywords and evaluating it is
// enough. If an import ever gets added there this fails loudly, which is the
// right outcome for a file that has to stay that simple.
//
// The point of these checks is that the disclosures are legal copy. Dropping
// the location or retention line in a later edit would be easy to do by
// accident and hard to spot in review.

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
  // The approved policy says "legally binding mandate". "request" reads
  // weaker for the same clause, so pin the approved word.
  ["the disclosure threshold in the approved wording", /legally binding mandate/i],
  ["the right to restrict processing, not only object", /object to or restrict/i],
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

console.log("\nRider specifics:");

test("covers trip data riders give us", () => {
  assert.ok(/flight number/i.test(allCopy), "flight numbers not mentioned");
  assert.ok(/luggage/i.test(allCopy), "luggage not mentioned");
});

test("location is scoped to an active trip, not always-on", () => {
  assert.ok(/while a trip is active/i.test(allCopy));
});

console.log("\nPointers:");

test("points at the full policy on the website", () => {
  assert.match(PRIVACY_FULL_URL, /ridearrivo\.com\/privacy/);
});

test("carries the date of the policy it summarises", () => {
  assert.strictEqual(PRIVACY_LAST_UPDATED, "August 22, 2026");
});

console.log(`\n${passed} passed`);
