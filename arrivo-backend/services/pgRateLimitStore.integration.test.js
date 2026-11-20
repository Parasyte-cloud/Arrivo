// The shared rate-limit store, against a REAL Postgres.
//   DATABASE_URL=postgres://... node services/pgRateLimitStore.integration.test.js
const assert = require("assert");
const { pool, ready } = require("../db/db");
const { PgRateLimitStore } = require("./pgRateLimitStore");

let passed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.log(`FAIL  ${name}\n      ${e.stack.split("\n").slice(0, 3).join("\n      ")}`); process.exitCode = 1; }
}

(async () => {
  await ready;
  const name = `t-${Date.now()}`;
  const mk = (n = name, p = pool) => { const s = new PgRateLimitStore({ pool: p, name: n }); s.init({ windowMs: 400 }); return s; };

  await test("two servers share one count", async () => {
    const a = mk(), b = mk();
    assert.strictEqual((await a.increment("u1")).totalHits, 1);
    assert.strictEqual((await b.increment("u1")).totalHits, 2);
    assert.strictEqual((await a.increment("u1")).totalHits, 3);
    assert.strictEqual((await a.increment("u2")).totalHits, 1, "another key is counted apart");
  });

  await test("simultaneous hits are not lost", async () => {
    const a = mk(), b = mk();
    await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).increment("race")));
    assert.strictEqual((await a.increment("race")).totalHits, 21);
  });

  await test("two limiters with different names do not share counts", async () => {
    const a = mk(), other = mk(`${name}-other`);
    await a.increment("same-key");
    assert.strictEqual((await other.increment("same-key")).totalHits, 1);
  });

  await test("the window resets after it ends", async () => {
    const a = mk(`${name}-reset`);
    await a.increment("w"); await a.increment("w");
    await new Promise((r) => setTimeout(r, 500));
    assert.strictEqual((await a.increment("w")).totalHits, 1);
  });

  await test("decrement and resetKey work", async () => {
    const a = mk(`${name}-dec`);
    await a.increment("d"); await a.increment("d");
    await a.decrement("d");
    assert.strictEqual((await a.increment("d")).totalHits, 2);
    await a.resetKey("d");
    assert.strictEqual((await a.increment("d")).totalHits, 1);
  });

  await test("a database failure never blocks: it counts in memory instead", async () => {
    const broken = { query: async () => { throw new Error("connection refused"); } };
    const s = mk(`${name}-down`, broken);
    const origErr = console.error; console.error = () => {};
    try {
      assert.strictEqual((await s.increment("m")).totalHits, 1);
      assert.strictEqual((await s.increment("m")).totalHits, 2);
      await s.decrement("m"); await s.resetKey("m");
      assert.strictEqual((await s.increment("m")).totalHits, 1);
    } finally { console.error = origErr; }
  });

  await pool.query("DELETE FROM rate_limit_hits WHERE store LIKE $1", [`${name}%`]);
  console.log(`\n${passed} passed`);
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
