// Pure rules of automatic repricing: when a price may move and when it must hold.
const assert = require("assert");
const { planTier, coverageForTier } = require("./autoReprice");

const OPTS = { maxStepPct: 5, minSamples: 8, minSources: 2, windowDays: 3, cooldownHours: 24, bandMinPct: 70, bandMaxPct: 150, tolerancePct: 8 };
const defaults = { baseFareNaira: 500, perKmNaira: 100, perMinNaira: 20, minimumFareNaira: 1000 };
const now = new Date("2026-10-09T08:00:00Z");

// n samples per source where our fare is `ratio` times theirs
function samples(ratio, sources = ["bolt", "uber"], perSource = 4) {
  const out = [];
  for (const source of sources) for (let i = 0; i < perSource; i++) out.push({ source, observed_fare_naira: 1000, our_fare_naira: Math.round(1000 * ratio) });
  return out;
}
const plan = (over = {}) => planTier({ tier: "economy", samples: samples(1.3), current: { ...defaults }, defaults, lastAutoChangeAt: null, now, ...over }, OPTS);

let passed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passed++; } catch (e) { console.log(`FAIL  ${name}\n      ${e.stack}`); process.exitCode = 1; }
}

test("consistently dearer than the market: lowers prices, capped at the step", () => {
  const p = plan();
  assert.strictEqual(p.action, "change");
  assert.strictEqual(p.changePct, -5);
  assert.strictEqual(p.proposed.perKmNaira, 95);
  assert.strictEqual(p.proposed.baseFareNaira, 475);
});

test("consistently cheaper than the market: raises prices", () => {
  const p = plan({ samples: samples(0.8) });
  assert.strictEqual(p.action, "change");
  assert.strictEqual(p.changePct, 5);
  assert.strictEqual(p.proposed.perKmNaira, 105);
});

test("in line with the market holds", () => {
  assert.strictEqual(plan({ samples: samples(1.03) }).reason, "in_line");
});

test("too few samples holds", () => {
  assert.strictEqual(plan({ samples: samples(1.3, ["bolt", "uber"], 3) }).reason, "not_enough_samples");
});

test("one competitor alone cannot move the price", () => {
  assert.strictEqual(plan({ samples: samples(1.3, ["bolt"], 10) }).reason, "not_enough_sources");
});

test("a source with a single sample does not count as a source", () => {
  const s = [...samples(1.3, ["bolt"], 8), { source: "uber", observed_fare_naira: 1000, our_fare_naira: 1300 }];
  assert.strictEqual(plan({ samples: s }).reason, "not_enough_sources");
});

test("sources that disagree hold", () => {
  const s = [...samples(1.3, ["bolt"], 5), ...samples(0.8, ["uber"], 5)];
  assert.strictEqual(plan({ samples: s }).reason, "sources_disagree");
});

test("a recent automatic change blocks another (cooldown)", () => {
  const recent = new Date(now.getTime() - 3 * 3600 * 1000);
  assert.strictEqual(plan({ lastAutoChangeAt: recent }).reason, "cooldown");
  const old = new Date(now.getTime() - 25 * 3600 * 1000);
  assert.strictEqual(plan({ lastAutoChangeAt: old }).action, "change");
});

test("never leaves the band around the code default", () => {
  const low = { baseFareNaira: 351, perKmNaira: 70, perMinNaira: 14, minimumFareNaira: 700 };
  const p = plan({ current: low });
  assert.strictEqual(p.action, "hold");
  assert.strictEqual(p.reason, "outside_band");
  const high = { baseFareNaira: 750, perKmNaira: 150, perMinNaira: 30, minimumFareNaira: 1500 };
  assert.strictEqual(plan({ current: high, samples: samples(0.8) }).reason, "outside_band");
});

test("the minimum fare never drops below the base fare", () => {
  const cur = { baseFareNaira: 900, perKmNaira: 100, perMinNaira: 20, minimumFareNaira: 900 };
  const p = plan({ current: cur, defaults: { ...defaults, baseFareNaira: 900, minimumFareNaira: 900 } });
  assert.ok(p.proposed.minimumFareNaira >= p.proposed.baseFareNaira);
});

test("coverage says exactly what is still missing", () => {
  const some = samples(1.3, ["bolt"], 3);
  const c = coverageForTier("economy", some, OPTS);
  assert.strictEqual(c.ready, false);
  assert.strictEqual(c.needSamples, 5);
  assert.strictEqual(c.needSources, 1);
  assert.ok(c.missing.includes("5 more samples") && c.missing.includes("1 more competitor"));
  const enough = coverageForTier("economy", samples(1.3), OPTS);
  assert.strictEqual(enough.ready, true);
  assert.strictEqual(enough.missing, "");
  assert.strictEqual(coverageForTier("economy", [], OPTS).needSamples, 8);
});

console.log(`\n${passed} passed`);
