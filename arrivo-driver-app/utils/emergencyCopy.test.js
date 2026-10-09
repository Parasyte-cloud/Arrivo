// Tests for the Emergency Button copy. Run directly:
//   node utils/emergencyCopy.test.js
//
// The module is import-free, so it is evaluated without a bundler. The last
// block checks that the dashboard uses it rather than carrying its own wording,
// which is the whole point of having one place to edit.

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

const src = read("utils/emergencyCopy.js");
assert.ok(!/^\s*import\s/m.test(src), "emergencyCopy.js has to stay import-free for this test to load it");
const names = [...src.matchAll(/^export (?:const|function) (\w+)/gm)].map((m) => m[1]);
const C = new Function(src.replace(/^export (const|function) /gm, "$1 ") + `\nreturn { ${names.join(", ")} };`)();

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

console.log("Emergency Button copy (driver):");
test("every string is present and none contains an em dash", () => {
  assert.ok(names.length >= 14);
  for (const n of names) {
    const value = typeof C[n] === "function" ? C[n](3) : C[n];
    assert.ok(typeof value === "string" && value.trim().length > 0, `${n} is empty`);
    assert.ok(!value.includes(String.fromCharCode(0x2014)), `${n} has an em dash`);
  }
  assert.ok(!src.includes(String.fromCharCode(0x2014)), "no em dash anywhere in the file");
});
test("links go to the website's emergency button sections over https", () => {
  assert.strictEqual(C.EMERGENCY_PRIVACY_URL, "https://ridearrivo.com/privacy.html#emergency-button");
  assert.strictEqual(C.EMERGENCY_TERMS_URL, "https://ridearrivo.com/terms.html#emergency-button");
});
test("the countdown tells the driver the listening device may be activated, before it sends", () => {
  assert.ok(/listening device/i.test(C.EMERGENCY_COUNTDOWN_NOTICE));
  assert.ok(/operations team/i.test(C.EMERGENCY_COUNTDOWN_NOTICE));
  assert.strictEqual(C.emergencyCountdownText(2), "Sending emergency alert in 2...");
});
test("the button is called the Emergency Button", () => {
  assert.ok(/Emergency Button/.test(C.EMERGENCY_BUTTON_LABEL));
});

console.log("\nThe dashboard uses the module:");
test("DashboardScreen takes its emergency wording from the module", () => {
  const s = read("screens/DashboardScreen.js");
  assert.ok(s.includes('from "../utils/emergencyCopy"'));
  assert.ok(s.includes("<EmergencyLinks />"));
  for (const phrase of ["Emergency SOS", "Emergency alert active", "Sending emergency alert in", "Retry sending alert", "Activate listening device", "Listening device: on"]) {
    assert.ok(!s.includes(phrase), `DashboardScreen still has its own "${phrase}"`);
  }
});
test("there is no manual way to switch the listening device on from the driver app", () => {
  assert.ok(!read("services/api.js").includes("activateListeningDevice"));
  assert.ok(!read("screens/DashboardScreen.js").includes("activateListeningDevice"));
});
test("the links component takes URLs only from the module", () => {
  const s = read("components/EmergencyLinks.js");
  assert.ok(!/https?:\/\//.test(s), "EmergencyLinks must not hardcode a URL");
});

console.log(`\n${passed} passed`);
