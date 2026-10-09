// Tests for the Emergency Button copy. Run directly:
//   node utils/emergencyCopy.test.js
//
// The module is import-free, so it is evaluated without a bundler. The last
// block checks that the screens use it rather than carrying their own wording,
// which is the whole point of having one place to edit.

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

const src = read("utils/emergencyCopy.js");
assert.ok(!/^\s*import\s/m.test(src), "emergencyCopy.js has to stay import-free for this test to load it");
const names = [...src.matchAll(/^export const (\w+)/gm)].map((m) => m[1]);
const C = new Function(src.replace(/^export const /gm, "const ") + `\nreturn { ${names.join(", ")} };`)();

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

console.log("Emergency Button copy:");
test("every string is present and none contains an em dash", () => {
  assert.ok(names.length >= 15);
  for (const n of names) {
    assert.ok(typeof C[n] === "string" && C[n].trim().length > 0, `${n} is empty`);
    assert.ok(!C[n].includes(String.fromCharCode(0x2014)), `${n} has an em dash`);
  }
  assert.ok(!src.includes(String.fromCharCode(0x2014)), "no em dash anywhere in the file");
});
test("links go to the website's emergency button sections over https", () => {
  assert.strictEqual(C.EMERGENCY_PRIVACY_URL, "https://ridearrivo.com/privacy.html#emergency-button");
  assert.strictEqual(C.EMERGENCY_TERMS_URL, "https://ridearrivo.com/terms.html#emergency-button");
});
test("the confirm text tells the person the listening device may be activated", () => {
  // The privacy policy promises the button asks first and says this. Dropping
  // it from the confirm text would break that promise.
  assert.ok(/listening device/i.test(C.EMERGENCY_CONFIRM_BODY));
  assert.ok(/only in an emergency/i.test(C.EMERGENCY_CONFIRM_BODY));
  assert.ok(/ops|operations team/i.test(C.EMERGENCY_CONFIRM_BODY));
});
test("the button is called the Emergency Button, with no manual activation wording", () => {
  assert.ok(/Emergency Button/.test(C.EMERGENCY_BUTTON_LABEL));
  for (const n of names) assert.ok(!/activate listening device/i.test(C[n]), n);
});

console.log("\nScreens use the module:");
test("TrackingScreen takes its emergency wording from the module", () => {
  const s = read("screens/TrackingScreen.js");
  assert.ok(s.includes('from "../utils/emergencyCopy"'));
  assert.ok(s.includes("<EmergencyLinks />"));
  for (const phrase of ["I don't feel safe", "Trigger safety alert", "Yes, alert support", "Activate listening device", "Listening device: on"]) {
    assert.ok(!s.includes(phrase), `TrackingScreen still has its own "${phrase}"`);
  }
});
test("there is no manual way to switch the listening device on from the rider app", () => {
  assert.ok(!read("services/api.js").includes("activateListeningDevice"));
  assert.ok(!read("screens/TrackingScreen.js").includes("activateListeningDevice"));
});
test("the links component takes URLs only from the module", () => {
  const s = read("components/EmergencyLinks.js");
  assert.ok(!/https?:\/\//.test(s), "EmergencyLinks must not hardcode a URL");
  assert.ok(s.includes("EMERGENCY_PRIVACY_URL") && s.includes("EMERGENCY_TERMS_URL"));
});

console.log(`\n${passed} passed`);
