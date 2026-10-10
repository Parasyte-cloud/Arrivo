const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");

// Account lookup stubbed: a live rider with token_version 0.
const dbPath = require.resolve("../db/db");
require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: {
    pool: {
      async query() {
        return { rows: [{ deleted_at: null, deletion_started_at: null, role: "rider", token_version: 0 }] };
      },
    },
  },
};
const { requireAuth } = require("./auth");

const SECRET = "jwt-algorithm-pin-local-test-secret-0123456789";
process.env.JWT_SECRET = SECRET;

async function run(token) {
  let nextCalled = false;
  let status = 200;
  const req = { method: "GET", originalUrl: "/api/rides", url: "/api/rides", headers: { authorization: `Bearer ${token}` } };
  const res = { status(c) { status = c; return this; }, json() { return this; } };
  await requireAuth(req, res, () => { nextCalled = true; });
  return { nextCalled, status };
}

test("a normal HS256 token is accepted", async () => {
  const t = jwt.sign({ id: 1, email: "a@b.c", role: "rider", tv: 0 }, SECRET, { expiresIn: "5m" });
  assert.equal((await run(t)).nextCalled, true);
});

test("a legacy token with no version field is still accepted (installed apps keep working)", async () => {
  const t = jwt.sign({ id: 1, email: "a@b.c", role: "rider" }, SECRET, { expiresIn: "5m" });
  assert.equal((await run(t)).nextCalled, true);
});

test("an unsigned alg:none token is refused", async () => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const t = `${b64({ alg: "none", typ: "JWT" })}.${b64({ id: 1, role: "admin" })}.`;
  const r = await run(t);
  assert.equal(r.nextCalled, false);
  assert.equal(r.status, 401);
});

test("a token signed with the right secret but another algorithm is refused", async () => {
  const t = jwt.sign({ id: 1, email: "a@b.c", role: "rider", tv: 0 }, SECRET, { algorithm: "HS512", expiresIn: "5m" });
  const r = await run(t);
  assert.equal(r.nextCalled, false);
  assert.equal(r.status, 401);
});
