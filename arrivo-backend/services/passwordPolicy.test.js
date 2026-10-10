const test = require("node:test");
const assert = require("node:assert/strict");
const { passwordProblem, MAX_PASSWORD_BYTES } = require("./passwordPolicy");

test("accepts an ordinary password", () => {
  assert.equal(passwordProblem("correct horse battery"), null);
});

test("rejects fewer than 8 characters", () => {
  assert.match(passwordProblem("short7!"), /at least 8/);
});

test("accepts exactly 72 bytes and rejects 73", () => {
  assert.equal(passwordProblem("a".repeat(72)), null);
  assert.match(passwordProblem("a".repeat(73)), /too long/);
});

test("counts bytes, not characters: 40 two-byte characters is 80 bytes", () => {
  const accents = "é".repeat(40);
  assert.equal(accents.length, 40);
  assert.equal(Buffer.byteLength(accents), 80);
  assert.match(passwordProblem(accents), /too long/);
  assert.equal(passwordProblem("é".repeat(36)), null); // 72 bytes
});

test("rejects non strings such as arrays and objects", () => {
  assert.ok(passwordProblem(["password1"]));
  assert.ok(passwordProblem({ length: 99 }));
  assert.ok(passwordProblem(12345678));
});

test("the limit matches what bcrypt really reads", () => {
  const bcrypt = require("bcryptjs");
  const base = "x".repeat(MAX_PASSWORD_BYTES);
  const hash = bcrypt.hashSync(base + "ignored tail", 4);
  // Proves the reason for the cap: bytes past 72 do not change the hash check.
  assert.equal(bcrypt.compareSync(base + "a completely different tail", hash), true);
});
