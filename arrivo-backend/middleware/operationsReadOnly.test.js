const test = require("node:test");
const assert = require("node:assert/strict");
const { enforceOperationsReadOnly } = require("./operationsReadOnly");

function run(role, method, url) {
  let status = 200;
  let passed = false;
  const res = { status(code) { status = code; return this; }, json() { return this; } };
  enforceOperationsReadOnly({ user: { role }, method, originalUrl: url }, res, () => { passed = true; });
  return passed ? 200 : status;
}

test("operations can read the riders list", () => {
  assert.equal(run("operations", "GET", "/api/admin/riders"), 200);
});

test("operations still cannot change riders or wallets", () => {
  assert.equal(run("operations", "PATCH", "/api/admin/riders/5/verify-id"), 403);
  assert.equal(run("operations", "PATCH", "/api/admin/riders/5/wallet-adjust"), 403);
  assert.equal(run("operations", "POST", "/api/admin/riders"), 403);
});

test("operations still cannot read pages outside the approved list", () => {
  assert.equal(run("operations", "GET", "/api/admin/waitlist"), 403);
  assert.equal(run("operations", "GET", "/api/admin/express/pricing"), 403);
});

test("other roles are untouched by this middleware", () => {
  assert.equal(run("support", "GET", "/api/admin/riders"), 200);
  assert.equal(run("admin", "PATCH", "/api/admin/riders/5/verify-id"), 200);
});
