const test = require("node:test");
const assert = require("node:assert/strict");
const { assessJwtSecret, checkJwtSecretAtStartup } = require("./jwtSecretCheck");

function logger() {
  const lines = { error: [], warn: [] };
  return { lines, error: (m) => lines.error.push(m), warn: (m) => lines.warn.push(m) };
}
const STRONG = require("crypto").randomBytes(48).toString("base64url");

test("a long random secret is ok", () => {
  assert.equal(assessJwtSecret(STRONG).level, "ok");
});

test("missing or empty is missing", () => {
  assert.equal(assessJwtSecret(undefined).level, "missing");
  assert.equal(assessJwtSecret("").level, "missing");
});

test("short, placeholder and repetitive secrets are weak", () => {
  assert.equal(assessJwtSecret("tooshort").level, "weak");
  assert.equal(assessJwtSecret("changeme").level, "weak");
  assert.equal(assessJwtSecret("a".repeat(64)).level, "weak");
});

test("missing secret stops startup", () => {
  const log = logger();
  assert.equal(checkJwtSecretAtStartup({}, log), false);
  assert.equal(log.lines.error.length, 1);
});

test("weak secret warns but still starts by default", () => {
  const log = logger();
  assert.equal(checkJwtSecretAtStartup({ JWT_SECRET: "tooshort" }, log), true);
  assert.equal(log.lines.warn.length, 1);
  assert.equal(log.lines.error.length, 0);
});

test("weak secret stops startup when JWT_SECRET_ENFORCE=true", () => {
  const log = logger();
  assert.equal(checkJwtSecretAtStartup({ JWT_SECRET: "tooshort", JWT_SECRET_ENFORCE: "true" }, log), false);
});

test("strong secret starts silently", () => {
  const log = logger();
  assert.equal(checkJwtSecretAtStartup({ JWT_SECRET: STRONG, JWT_SECRET_ENFORCE: "true" }, log), true);
  assert.equal(log.lines.warn.length + log.lines.error.length, 0);
});

test("the warning never prints the secret", () => {
  const log = logger();
  checkJwtSecretAtStartup({ JWT_SECRET: "tooshort-but-private" }, log);
  assert.ok(!log.lines.warn.join(" ").includes("tooshort-but-private"));
});
