// The rider app, the driver app and the server each list the options for
// ArrivoAir, ArrivoBoat and ArrivoRemovals. If they drift, a rider could pick
// something the server refuses, or a driver could see a raw code instead of a
// name. This reads the app files and checks them against the server's rules.
//
//   node services/appParity.test.js
// Skipped when the app folders are not next to the backend (backend-only checkout).

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { TIERS } = require("./serviceRequests");

const riderFile = path.join(__dirname, "..", "..", "arrivo-app", "tiers", "requestTiers.js");
const driverFile = path.join(__dirname, "..", "..", "arrivo-driver-app", "tiers", "jobs.js");

if (!fs.existsSync(riderFile) || !fs.existsSync(driverFile)) {
  console.log("  skip  app folders not present, parity not checked");
  process.exit(0);
}

function load(file, names) {
  const src = fs.readFileSync(file, "utf8");
  assert.ok(!/^\s*import\s/m.test(src), `${path.basename(file)} must stay import-free`);
  return new Function(
    src.replace(/^export const /gm, "const ").replace(/^export function /gm, "function ") + `\nreturn { ${names} };`
  )();
}

const rider = load(riderFile, "REQUEST_TIERS").REQUEST_TIERS;
const driver = load(driverFile, "SERVICE_TIERS, TIER_LABELS");

let passed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passed++; } catch (e) { console.log(`FAIL  ${name}\n      ${e.message}`); process.exitCode = 1; }
}

test("the same three request tiers exist everywhere", () => {
  const server = Object.keys(TIERS).sort();
  assert.deepEqual(Object.keys(rider).sort(), server);
  assert.deepEqual(Object.keys(driver.SERVICE_TIERS).sort(), server);
});

for (const key of Object.keys(TIERS)) {
  const t = TIERS[key];

  test(`${t.label}: rider app offers exactly the options the server accepts`, () => {
    assert.deepEqual(rider[key].options.map((o) => o.value).sort(), [...t.options].sort());
  });

  test(`${t.label}: driver app has a name for every option`, () => {
    assert.deepEqual(Object.keys(driver.SERVICE_TIERS[key].options).sort(), [...t.options].sort());
    for (const label of Object.values(driver.SERVICE_TIERS[key].options)) assert.ok(label && label.length > 0);
  });

  test(`${t.label}: same label in both apps and on the server`, () => {
    assert.equal(rider[key].label, t.label);
    assert.equal(driver.SERVICE_TIERS[key].label, t.label);
    assert.equal(driver.TIER_LABELS[key], t.label);
  });

  test(`${t.label}: rider limits match the server`, () => {
    assert.equal(rider[key].maxPassengers, t.maxPassengers);
    assert.equal(!!rider[key].usesCrewSize, !!t.usesCrewSize);
    assert.deepEqual(rider[key].crewSizes || [], t.crewSizes || []);
  });
}

test("the rider and driver apps agree on the names of all six tiers", () => {
  assert.deepEqual(
    Object.values(driver.TIER_LABELS).sort(),
    ["ArrivoAir", "ArrivoBoat", "ArrivoChauffer", "ArrivoExpress", "ArrivoRemovals", "RideArrivo"]
  );
});

console.log(`\n${passed} passed`);
