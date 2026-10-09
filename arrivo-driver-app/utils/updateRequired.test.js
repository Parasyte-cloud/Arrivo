// Tests for the update-required state. Run directly:
//   node utils/updateRequired.test.js
// Same module as arrivo-app/utils/updateRequired.js; kept as a copy because the
// two apps do not share code.

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "updateRequired.js"), "utf8");
assert.ok(!/^\s*import\s/m.test(src), "updateRequired.js has to stay import-free for this test to load it");
assert.ok(!src.includes(String.fromCharCode(0x2014)), "no em dash in updateRequired.js");
const U = new Function(
  src.replace(/^export const /gm, "const ").replace(/^export function /gm, "function ") +
    "\nreturn { parseUpdateRequired, getUpdateRequired, subscribeUpdateRequired, noteResponse };"
)();

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

const body = { error: "Please update.", code: "app_update_required", minVersion: "1.2.0", storeUrl: "https://play.google.com/store/apps/details?id=com.arrivo.driver" };

console.log("Update required (driver):");
test("only a real 426 with the code counts", () => {
  assert.ok(U.parseUpdateRequired(426, body));
  assert.strictEqual(U.parseUpdateRequired(426, { error: "x" }), null);
  assert.strictEqual(U.parseUpdateRequired(500, body), null);
  assert.strictEqual(U.parseUpdateRequired(426, null), null);
});
test("a store link that is not https is dropped", () => {
  assert.strictEqual(U.parseUpdateRequired(426, { ...body, storeUrl: "javascript:alert(1)" }).storeUrl, null);
  assert.strictEqual(U.parseUpdateRequired(426, { ...body, storeUrl: "http://example.com" }).storeUrl, null);
});
test("noteResponse ignores ordinary responses, records an update and notifies", () => {
  U.noteResponse(401, { error: "no" });
  assert.strictEqual(U.getUpdateRequired(), null);
  let calls = 0;
  const off = U.subscribeUpdateRequired(() => { calls += 1; });
  U.noteResponse(426, body);
  assert.strictEqual(calls, 1);
  assert.strictEqual(U.getUpdateRequired().minVersion, "1.2.0");
  off();
});
test("the driver app sends its own name in the headers", () => {
  const info = fs.readFileSync(path.join(__dirname, "..", "services", "clientInfo.js"), "utf8");
  assert.ok(info.includes('"X-App-Name": "driver"'));
});

console.log(`\n${passed} passed`);
