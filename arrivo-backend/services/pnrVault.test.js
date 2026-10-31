const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const vault = require("./pnrVault");

test("with no key the vault refuses to store a code", () => {
  delete process.env.FLIGHT_PNR_KEY;
  assert.equal(vault.available(), false);
  assert.throws(() => vault.seal("AB12CD", 7), (e) => e.code === "PNR_KEY_MISSING");
});

test("a sealed code opens for its own ride and only that ride", () => {
  process.env.FLIGHT_PNR_KEY = crypto.randomBytes(32).toString("base64");
  const sealed = vault.seal("AB12CD", 7);
  assert.doesNotMatch(sealed, /AB12CD/);
  assert.equal(vault.open(sealed, 7), "AB12CD");
  assert.throws(() => vault.open(sealed, 8));
  const parts = sealed.split(".");
  parts[3] = Buffer.from("tampered").toString("base64url");
  assert.throws(() => vault.open(parts.join("."), 7));
  assert.notEqual(vault.seal("AB12CD", 7), sealed, "a fresh IV every time");
});
