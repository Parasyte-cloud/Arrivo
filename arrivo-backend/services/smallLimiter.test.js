const test = require("node:test");
const assert = require("node:assert/strict");
const { createLimiter } = require("./smallLimiter");

test("allows up to max in the window, then refuses, then recovers", () => {
  let t = 0;
  const allow = createLimiter({ max: 3, windowMs: 1000, now: () => t });
  assert.deepEqual([allow("a"), allow("a"), allow("a"), allow("a")], [true, true, true, false]);
  assert.equal(allow("b"), true, "another user is not affected");
  t = 1001;
  assert.equal(allow("a"), true);
});
