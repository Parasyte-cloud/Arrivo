// Tests for the Lagos wall-clock helpers. Run directly:
//   node utils/lagosTime.test.js
//
// The helpers are import-free, so the module is evaluated without a bundler.
// Run it under different zones to prove the phone's timezone never matters:
//   TZ=Europe/London node utils/lagosTime.test.js
//   TZ=America/Los_Angeles node utils/lagosTime.test.js
//   TZ=Asia/Kolkata node utils/lagosTime.test.js

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "lagosTime.js"), "utf8");
assert.ok(!/^\s*import\s/m.test(src), "lagosTime.js has to stay import-free for this test to load it");
assert.ok(!src.includes(String.fromCharCode(0x2014)), "no em dash in lagosTime.js");

const load = new Function(
  src.replace(/^export const /gm, "const ").replace(/^export function /gm, "function ") +
    "\nreturn { lagosParts, lagosInstant, combineLagos, wallClockDate, lagosToday, lagosDayLabel, lagosScheduleInstant, formatLagos, earliestInstant };"
);
const T = load();

let passed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
    passed++;
  } catch (e) {
    console.log(`FAIL  ${name}\n      ${e.message}`);
    process.exitCode = 1;
  }
}

// 2026-10-09 22:30 UTC is 23:30 in Lagos the same day.
const NOW = Date.UTC(2026, 9, 9, 22, 30);

console.log(`Lagos time helpers (TZ=${process.env.TZ || "system"}):`);

test("lagosParts reads the Lagos clock", () => {
  const p = T.lagosParts(NOW);
  assert.deepStrictEqual([p.year, p.month, p.day, p.hour, p.minute], [2026, 10, 9, 23, 30]);
});

test("lagosParts rolls into the next Lagos day before UTC does", () => {
  const p = T.lagosParts(Date.UTC(2026, 9, 9, 23, 30));
  assert.deepStrictEqual([p.day, p.hour, p.minute], [10, 0, 30]);
});

test("lagosInstant: 09:00 Lagos is 08:00 UTC", () => {
  assert.strictEqual(T.lagosInstant(2026, 10, 10, 9, 0).toISOString(), "2026-10-10T08:00:00.000Z");
});

test("lagosInstant rejects impossible moments", () => {
  assert.strictEqual(T.lagosInstant(2026, 2, 31, 9, 0), null);
  assert.strictEqual(T.lagosInstant(2026, 13, 1, 9, 0), null);
  assert.strictEqual(T.lagosInstant(2026, 10, 10, 25, 0), null);
  assert.strictEqual(T.lagosInstant(2026, 10, 10, 9, 60), null);
});

test("combineLagos reads picker fields as the Lagos clock", () => {
  const date = new Date(2026, 9, 10, 3, 17); // time-of-day on the date part is ignored
  const time = new Date(2026, 0, 1, 14, 45);
  assert.strictEqual(T.combineLagos(date, time).toISOString(), "2026-10-10T13:45:00.000Z");
});

test("combineLagos gives null until both halves are picked", () => {
  assert.strictEqual(T.combineLagos(null, new Date()), null);
  assert.strictEqual(T.combineLagos(new Date(), null), null);
});

test("wallClockDate round-trips through combineLagos", () => {
  const w = T.wallClockDate(NOW);
  assert.strictEqual(T.combineLagos(w, w).getTime(), Math.floor(NOW / 60000) * 60000);
});

test("lagosToday follows Lagos, not the phone", () => {
  const t = T.lagosToday(Date.UTC(2026, 9, 9, 23, 30)); // already 10 Oct in Lagos
  assert.deepStrictEqual([t.getFullYear(), t.getMonth() + 1, t.getDate()], [2026, 10, 10]);
});

test("lagosDayLabel counts Lagos days", () => {
  assert.strictEqual(T.lagosDayLabel(0, NOW), "Fri 9 Oct");
  assert.strictEqual(T.lagosDayLabel(2, NOW), "Sun 11 Oct");
  assert.strictEqual(T.lagosDayLabel(1, Date.UTC(2026, 9, 9, 23, 30)), "Sun 11 Oct");
});

test("lagosScheduleInstant builds today + offset at hour:minute", () => {
  assert.strictEqual(T.lagosScheduleInstant(1, "9", "00", NOW).toISOString(), "2026-10-10T08:00:00.000Z");
});

test("lagosScheduleInstant uses the new Lagos day after midnight", () => {
  const after = Date.UTC(2026, 9, 9, 23, 30); // 00:30 on 10 Oct in Lagos
  assert.strictEqual(T.lagosScheduleInstant(0, "9", "00", after).toISOString(), "2026-10-10T08:00:00.000Z");
});

test("lagosScheduleInstant refuses free text that is not a real time", () => {
  for (const bad of ["", " ", "24", "-1", "9.5", "abc"]) {
    assert.strictEqual(T.lagosScheduleInstant(1, bad, "00", NOW), null, `hour ${JSON.stringify(bad)}`);
  }
  assert.strictEqual(T.lagosScheduleInstant(1, "9", "60", NOW), null);
  assert.strictEqual(T.lagosScheduleInstant(1, "9", "", NOW), null);
});

test("formatLagos is zone-independent and labelled", () => {
  assert.strictEqual(T.formatLagos(Date.UTC(2026, 9, 10, 13, 45)), "Sat 10 Oct, 14:45 (Lagos time)");
  assert.strictEqual(T.formatLagos(null), "");
  assert.strictEqual(T.formatLagos("nonsense"), "");
});

test("earliestInstant is at least N hours out and on a five minute mark", () => {
  const e = T.earliestInstant(12, NOW + 7 * 1000);
  assert.ok(e.getTime() >= NOW + 7000 + 12 * 3600 * 1000);
  assert.ok(e.getTime() - (NOW + 7000 + 12 * 3600 * 1000) < 5 * 60 * 1000);
  assert.strictEqual(e.getTime() % (5 * 60 * 1000), 0);
});

test("earliestInstant can round to quarter hours", () => {
  const e = T.earliestInstant(12, NOW, 15);
  assert.strictEqual(e.getTime() % (15 * 60 * 1000), 0);
  assert.ok(e.getTime() >= NOW + 12 * 3600 * 1000);
});

console.log(`\n${passed} passed`);
