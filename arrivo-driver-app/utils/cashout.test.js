// Run directly: node utils/cashout.test.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "cashout.js"), "utf8");
assert.ok(!/^\s*import\s/m.test(src), "cashout.js has to stay import-free");
const { parseAmount, statusTone, errorKey, newIdempotencyKey, filterBanks } = new Function(
  src.replace(/^export function /gm, "function ") + "\nreturn { parseAmount, statusTone, errorKey, newIdempotencyKey, filterBanks };"
)();
let passed = 0;
const test = (n, f) => { try { f(); console.log(`  ok  ${n}`); passed++; } catch (e) { console.log(`FAIL  ${n}\n${e.stack}`); process.exitCode = 1; } };

test("amounts parse to whole naira or null", () => {
  assert.strictEqual(parseAmount("5000"), 5000);
  assert.strictEqual(parseAmount("₦5,000"), 5000);
  assert.strictEqual(parseAmount(" 12 500 "), 12500);
  for (const bad of ["", "0", "-5", "12.5", "abc", "1e3", null, undefined]) assert.strictEqual(parseAmount(bad), null, String(bad));
});
test("status tone", () => { assert.strictEqual(statusTone("paid"), "teal"); assert.strictEqual(statusTone("queued"), "amber"); });
test("error key uses the code when a translation exists", () => {
  const has = (k) => k === "e_DAILY_LIMIT";
  assert.strictEqual(errorKey({ code: "DAILY_LIMIT" }, has), "e_DAILY_LIMIT");
  assert.strictEqual(errorKey({ code: "WHAT" }, has), null);
  assert.strictEqual(errorKey(new Error("x"), has), null);
  assert.strictEqual(errorKey(null, has), null);
});
test("idempotency keys differ between attempts", () => {
  assert.notStrictEqual(newIdempotencyKey(1, () => 0.123456), newIdempotencyKey(1, () => 0.654321));
  assert.ok(newIdempotencyKey().length >= 10);
});
test("bank search ignores case and spacing", () => {
  const banks = [{ code: "1", name: "Access Bank" }, { code: "2", name: "GTBank" }];
  assert.deepStrictEqual(filterBanks(banks, " gt ").map((b) => b.code), ["2"]);
  assert.strictEqual(filterBanks(banks, "").length, 2);
  assert.strictEqual(filterBanks(banks, "zzz").length, 0);
});
console.log(`\n${passed} passed`);
