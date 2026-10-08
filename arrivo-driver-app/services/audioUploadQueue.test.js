const assert = require("assert");
const { createUploadQueue } = require("./audioUploadQueue");

const noSleep = () => Promise.resolve();
let passed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.log(`FAIL  ${name}\n      ${e.stack}`); process.exitCode = 1; }
}

(async () => {
  await test("chunks are sent one at a time, in order", async () => {
    const order = [];
    let inFlight = 0, maxInFlight = 0;
    const q = createUploadQueue({ sleep: noSleep, uploadChunk: async (i) => { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); await new Promise((r) => setTimeout(r, 5)); order.push(i.seq); inFlight--; } });
    q.enqueue({ seq: 0 }); q.enqueue({ seq: 1 }); await q.enqueue({ seq: 2 });
    assert.deepStrictEqual(order, [0, 1, 2]);
    assert.strictEqual(maxInFlight, 1);
    assert.strictEqual(q.size(), 0);
  });
  await test("a failing chunk is retried and then sent", async () => {
    let tries = 0;
    const q = createUploadQueue({ sleep: noSleep, uploadChunk: async () => { tries++; if (tries < 3) throw new Error("no signal"); } });
    assert.strictEqual(await q.enqueue({ seq: 0 }), true);
    assert.strictEqual(tries, 3);
  });
  await test("a chunk that keeps failing stays queued, blocks later ones, and goes out on the next flush", async () => {
    let online = false; const sent = [];
    const q = createUploadQueue({ sleep: noSleep, maxAttemptsPerFlush: 2, uploadChunk: async (i) => { if (!online) throw new Error("offline"); sent.push(i.seq); } });
    assert.strictEqual(await q.enqueue({ seq: 0 }), false);
    assert.strictEqual(await q.enqueue({ seq: 1 }), false);
    assert.strictEqual(q.size(), 2);
    online = true;
    assert.strictEqual(await q.flush(), true);
    assert.deepStrictEqual(sent, [0, 1]);
  });
  await test("backoff doubles between attempts", async () => {
    const waits = [];
    const q = createUploadQueue({ baseDelayMs: 100, maxAttemptsPerFlush: 4, sleep: async (ms) => { waits.push(ms); }, uploadChunk: async () => { throw new Error("x"); } });
    await q.enqueue({ seq: 0 });
    assert.deepStrictEqual(waits, [100, 200, 400]);
  });
  await test("concurrent flush calls share one drain", async () => {
    let calls = 0;
    const q = createUploadQueue({ sleep: noSleep, uploadChunk: async () => { calls++; await new Promise((r) => setTimeout(r, 5)); } });
    q.enqueue({ seq: 0 });
    await Promise.all([q.flush(), q.flush()]);
    assert.strictEqual(calls, 1);
  });
  console.log(`\n${passed} passed`);
})();
