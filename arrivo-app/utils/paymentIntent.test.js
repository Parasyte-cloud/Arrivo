// Run: node utils/paymentIntent.test.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "paymentIntent.js"), "utf8");
assert.ok(!/^\s*import\s/m.test(src), "must stay import-free");
assert.ok(!src.includes(String.fromCharCode(0x2014)), "no em dash");
const M = new Function(src.replace(/^export const /gm, "const ").replace(/^export function /gm, "function ") +
  "\nreturn { PAYMENT_PURPOSES, buildPaymentInit, paymentInitHeaders };")();
let n = 0;
const t = (name, fn) => { fn(); n++; console.log("ok -", name); };

t("keeps email and amount, adds purpose", () => {
  assert.deepStrictEqual(M.buildPaymentInit({ email: "a@b.c", amountNaira: 500, purpose: "topup" }),
    { email: "a@b.c", amountNaira: 500, purpose: "topup" });
});
t("adds refId as a string when given", () => {
  assert.strictEqual(M.buildPaymentInit({ email: "a", amountNaira: 1, purpose: "tip", refId: 42 }).refId, "42");
});
t("drops empty or missing refId", () => {
  for (const r of [undefined, null, "", "  "]) assert.ok(!("refId" in M.buildPaymentInit({ email: "a", amountNaira: 1, purpose: "ride", refId: r })));
});
t("unknown purpose is not sent, payment body still valid", () => {
  const b = M.buildPaymentInit({ email: "a", amountNaira: 1, purpose: "bogus" });
  assert.deepStrictEqual(b, { email: "a", amountNaira: 1 });
});
t("header only when a token exists", () => {
  assert.deepStrictEqual(M.paymentInitHeaders("tok"), { Authorization: "Bearer tok" });
  assert.deepStrictEqual(M.paymentInitHeaders(null), {});
});
t("every screen uses a known purpose", () => {
  const dir = path.join(__dirname, "..", "screens");
  for (const f of fs.readdirSync(dir)) {
    const s = fs.readFileSync(path.join(dir, f), "utf8");
    for (const m of s.matchAll(/initializePayment\(token, \{[^}]*purpose: "(\w+)"/g)) assert.ok(M.PAYMENT_PURPOSES.includes(m[1]), f + " " + m[1]);
    assert.ok(!/initializePayment\(user\.email/.test(s), f + " still uses the old signature");
  }
});
console.log(n + " passed");
