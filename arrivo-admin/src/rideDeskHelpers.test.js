// Run directly: node src/rideDeskHelpers.test.js
import assert from "node:assert";
import { firstName, greeting, callOutcome, formatSeconds, tabsFor, reassignableTeams, canManageDuty, teamLine } from "./rideDeskHelpers.js";

let passed = 0;
const test = (n, f) => { try { f(); console.log(`  ok  ${n}`); passed++; } catch (e) { console.log(`FAIL  ${n}\n${e.stack}`); process.exitCode = 1; } };

test("names", () => {
  assert.strictEqual(firstName("  Ada  Nwosu "), "Ada"); assert.strictEqual(firstName(null), ""); assert.strictEqual(firstName(""), "");
  assert.strictEqual(greeting({ name: "Ibrahim Musa" }), "Say hello to Ibrahim");
  assert.strictEqual(greeting({ firstName: "Ada", name: "X Y" }), "Say hello to Ada");
  assert.strictEqual(greeting(null), "Greet them by name");
});
test("durations", () => {
  assert.strictEqual(formatSeconds(0), "0s"); assert.strictEqual(formatSeconds(59), "59s");
  assert.strictEqual(formatSeconds(61), "1m 01s"); assert.strictEqual(formatSeconds(-5), "0s"); assert.strictEqual(formatSeconds(undefined), "0s");
});
test("call outcomes read like sentences", () => {
  assert.strictEqual(callOutcome({ status: "ended", seconds: 125, from: "Tola", to: "Ada", byStaff: true }), "Tola to Ada spoke for 2m 05s");
  assert.strictEqual(callOutcome({ status: "missed", from: "Ada", to: "Ibrahim", byStaff: false }), "Ada and Ibrahim, not answered");
  assert.ok(callOutcome({ status: "failed", reason: "provider_error", from: "A", to: "B" }).includes("provider error"));
  assert.ok(callOutcome({ status: "weird", from: "A", to: "B" }).includes("weird"));
});
test("tabs and powers by role", () => {
  assert.deepStrictEqual(tabsFor({ role: "support", isLead: false }).map((t) => t.id), ["mine", "all", "unassigned", "team"]);
  assert.ok(tabsFor({ role: "support", isLead: true }).some((t) => t.id === "log"));
  assert.ok(tabsFor({ role: "admin" }).some((t) => t.id === "log"));
  assert.ok(!tabsFor({ role: "operations" }).some((t) => t.id === "log"));
  assert.deepStrictEqual(reassignableTeams({ role: "admin" }), ["support", "operations"]);
  assert.deepStrictEqual(reassignableTeams({ role: "support", isLead: true }), ["support"]);
  assert.deepStrictEqual(reassignableTeams({ role: "support", isLead: false }), []);
  assert.deepStrictEqual(reassignableTeams({ role: "operations", isLead: true }), []);
  assert.ok(canManageDuty({ role: "admin" }, { role: "operations" }));
  assert.ok(canManageDuty({ role: "support", isLead: true }, { role: "support" }));
  assert.ok(!canManageDuty({ role: "support", isLead: true }, { role: "operations" }));
  assert.ok(!canManageDuty({ role: "support", isLead: false }, { role: "support" }));
});
test("team line", () => {
  assert.strictEqual(teamLine({ support: { firstName: "Tola" }, operations: { firstName: "Chidi" } }), "Tola (Support) and Chidi (Operations)");
  assert.strictEqual(teamLine({ support: { firstName: "Tola" }, operations: null }), "Tola (Support)");
  assert.strictEqual(teamLine({ support: null, operations: null }), "Waiting for a team");
  assert.strictEqual(teamLine(null), "Waiting for a team");
});
console.log(`\n${passed} passed`);
