// Run: node services/engineDrivers.test.js   (no database or network needed)
const assert = require("assert");
const { fetchEngineDrivers, mapDriver, resetCache } = require("./engineDrivers");

let passed = 0;
async function test(name, fn) {
  try { resetCache(); await fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.log(`FAIL  ${name}\n      ${e.stack.split("\n").slice(0, 3).join("\n      ")}`); process.exitCode = 1; }
}
const env = { ARRIVO_ENGINE_URL: "https://engine.test/", ARRIVO_ENGINE_OPS_TOKEN: "tok" };
const row = { driver: { id: "d1", displayName: "Ada", status: "pending", verificationStage: "awaiting_inspection", createdAt: "2026-11-06T10:00:00Z", vehicle: { make: "Toyota", model: "Camry", year: 2015, plate: "ABC123", category: "sedan" } }, presence: null };

(async () => {
  await test("maps an engine driver to the Drivers list shape, tier express, read only id", async () => {
    const m = mapDriver(row);
    assert.strictEqual(m.id, "engine:d1"); assert.strictEqual(m.tier, "express"); assert.strictEqual(m.source, "engine");
    assert.strictEqual(m.make_model, "Toyota Camry 2015"); assert.strictEqual(m.is_verified, false); assert.strictEqual(m.is_online, false);
    assert.strictEqual(m.verification_stage, "awaiting_inspection");
  });
  await test("online only while presence is unexpired", async () => {
    const now = Date.parse("2026-11-06T12:00:00Z");
    assert.strictEqual(mapDriver({ ...row, presence: { online: true, expires_at: "2026-11-06T12:05:00Z" } }, now).is_online, true);
    assert.strictEqual(mapDriver({ ...row, presence: { online: true, expires_at: "2026-11-06T11:55:00Z" } }, now).is_online, false);
    assert.strictEqual(mapDriver({ driver: { ...row.driver, status: "approved" } }).is_verified, true);
  });
  await test("not configured when the url or token is missing, and no request is made", async () => {
    let called = false;
    const r = await fetchEngineDrivers({ env: {}, fetchImpl: async () => { called = true; } });
    assert.deepStrictEqual(r, { status: "not_configured", drivers: [] }); assert.strictEqual(called, false);
  });
  await test("sends the bearer token and returns mapped drivers", async () => {
    let seen;
    const r = await fetchEngineDrivers({ env, fetchImpl: async (url, o) => { seen = { url, auth: o.headers.authorization }; return { ok: true, status: 200, json: async () => ({ drivers: [row] }) }; } });
    assert.strictEqual(seen.url, "https://engine.test/ops/drivers"); assert.strictEqual(seen.auth, "Bearer tok");
    assert.strictEqual(r.status, "ok"); assert.strictEqual(r.drivers.length, 1);
  });
  await test("a rejected token and a down engine fail soft with a reason", async () => {
    assert.strictEqual((await fetchEngineDrivers({ env, fetchImpl: async () => ({ ok: false, status: 401 }) })).status, "token_rejected");
    resetCache();
    assert.strictEqual((await fetchEngineDrivers({ env, fetchImpl: async () => ({ ok: false, status: 502 }) })).status, "unreachable");
    resetCache();
    assert.strictEqual((await fetchEngineDrivers({ env, fetchImpl: async () => { throw new Error("down"); } })).status, "unreachable");
  });
  await test("a good answer is cached briefly so the page does not hammer the engine", async () => {
    let n = 0; const f = async () => { n++; return { ok: true, status: 200, json: async () => ({ drivers: [] }) }; };
    await fetchEngineDrivers({ env, fetchImpl: f, now: 1000 }); await fetchEngineDrivers({ env, fetchImpl: f, now: 2000 });
    assert.strictEqual(n, 1);
  });
  console.log(`\n${passed} passed`);
})();
