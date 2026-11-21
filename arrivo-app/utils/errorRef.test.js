// Run directly: node utils/errorRef.test.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "errorRef.js"), "utf8").replace(/^export (const|function) /gm, "$1 ");
const { REF_CHARS, newRef, errorCodeLine, messageWithCode, shortStack, pushReport } = new Function(
  src + "\nreturn { REF_CHARS, newRef, errorCodeLine, messageWithCode, shortStack, pushReport };"
)();

let passed = 0;
const test = (n, f) => { try { f(); console.log(`  ok  ${n}`); passed++; } catch (e) { console.log(`FAIL  ${n}\n${e.stack}`); process.exitCode = 1; } };

// Must match the server's check in arrivo-backend/middleware/errorTrail.js.
const SERVER_REF = /^RA-[A-HJKMNP-Z2-9]{6,12}$/;

test("refs are in the format the server accepts", () => {
  for (let i = 0; i < 2000; i++) assert.ok(SERVER_REF.test(newRef()));
});
test("no look-alike characters", () => {
  assert.ok(!/[01OIL]/.test(REF_CHARS));
});
test("edge of the random range stays in bounds", () => {
  assert.ok(SERVER_REF.test(newRef(() => 0)));
  assert.ok(SERVER_REF.test(newRef(() => 0.9999999)));
});
test("code line has both parts", () => {
  assert.strictEqual(errorCodeLine({ errorCode: "RIDES_400", ref: "RA-7KQ2MX" }), "Error code: RIDES_400 · Ref: RA-7KQ2MX");
});
test("code line is empty for a plain error", () => {
  assert.strictEqual(errorCodeLine(new Error("x")), "");
  assert.strictEqual(errorCodeLine(null), "");
});
test("message gets the code line underneath", () => {
  const e = Object.assign(new Error("scheduledPickupAt must be in the future."), { errorCode: "RIDES_400", ref: "RA-7KQ2MX" });
  assert.strictEqual(messageWithCode(e), "scheduledPickupAt must be in the future.\n\nError code: RIDES_400 · Ref: RA-7KQ2MX");
});
test("fallback text when the error has no message", () => {
  assert.strictEqual(messageWithCode({ ref: "RA-7KQ2MX" }, "Couldn't book."), "Couldn't book.\n\nRef: RA-7KQ2MX");
  assert.strictEqual(messageWithCode(null, "Couldn't book."), "Couldn't book.");
});
test("stack is trimmed to a few lines", () => {
  const e = new Error("boom");
  const s = shortStack(e, 2);
  assert.strictEqual(s.split(" | ").length, 2);
  assert.ok(s.length <= 1000);
});
test("report queue keeps the newest", () => {
  let q = [];
  for (let i = 0; i < 25; i++) q = pushReport(q, { n: i });
  assert.strictEqual(q.length, 20);
  assert.strictEqual(q[0].n, 5);
  assert.strictEqual(q[19].n, 24);
  assert.deepStrictEqual(pushReport("junk", { n: 1 }), [{ n: 1 }]);
});

console.log(`\nerrorRef: ${passed} passed`);
