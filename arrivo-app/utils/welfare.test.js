// Run directly: node utils/welfare.test.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "welfare.js"), "utf8");
assert.ok(!/^\s*import\s/m.test(src));
const w = new Function(src.replace(/^export (const|function) /gm, "$1 ") + "\nreturn { shouldWatch, secondsLeft, clock, pingBody, WELFARE_PING_MS };")();
let n = 0;
const test = (name, f) => { try { f(); console.log(`  ok  ${name}`); n++; } catch (e) { console.log(`FAIL  ${name}\n${e.stack}`); process.exitCode = 1; } };

test("only an in-progress trip is watched", () => {
  assert.ok(w.shouldWatch("in_progress"));
  for (const s of ["requested", "accepted", "completed", "cancelled", undefined]) assert.ok(!w.shouldWatch(s));
});
test("countdown never goes negative", () => {
  assert.equal(w.secondsLeft(10_000, 4_000), 6);
  assert.equal(w.secondsLeft(10_000, 20_000), 0);
  assert.equal(w.secondsLeft(null, 1), 0);
});
test("clock reads m:ss", () => { assert.equal(w.clock(105), "1:45"); assert.equal(w.clock(5), "0:05"); assert.equal(w.clock(-3), "0:00"); });
test("ping body only for a usable position", () => {
  assert.deepEqual(w.pingBody({ coords: { latitude: 6.5, longitude: 3.3, accuracy: 12 } }), { lat: 6.5, lng: 3.3, accuracy: 12 });
  assert.equal(w.pingBody({ coords: { latitude: NaN, longitude: 3 } }), null);
  assert.equal(w.pingBody(null), null);
});
test("pings go out about every 30 seconds", () => { assert.equal(w.WELFARE_PING_MS, 30000); });
console.log(`${n} passed`);
