// Run directly: node utils/quests.test.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "quests.js"), "utf8");
assert.ok(!/^\s*import\s/m.test(src), "quests.js has to stay import-free for this test to load it");
const { questState, questProgressPct, tripsLeft, timeLeftLabel, questRules, sortQuests } = new Function(
  src.replace(/^export function /gm, "function ") + "\nreturn { questState, questProgressPct, tripsLeft, timeLeftLabel, questRules, sortQuests };"
)();
const load = (f, names) => new Function(fs.readFileSync(path.join(__dirname, "..", "i18n", f), "utf8").replace(/^export (const|function) /gm, "$1 ") + `\nreturn { ${names} };`)();
const { TRANSLATIONS } = load("translations.js", "TRANSLATIONS");
const { translate } = load("i18n.js", "translate");
const t = (key, params) => translate(TRANSLATIONS, "en", key, params);

const now = new Date("2026-10-09T12:00:00Z");
const h = (n) => new Date(now.getTime() + n * 3600000).toISOString();
const q = (o = {}) => ({ id: 1, title: "T", targetTrips: 10, rewardNaira: 5000, progress: 4, startsAt: h(-24), endsAt: h(72), minTripKm: "1.00", minTripMinutes: 3, maxTripsPerRider: 2, minDriverRating: null, tier: null, earned: false, paid: false, quotaFull: false, ...o });

let passed = 0;
const test = (n, f) => { try { f(); console.log(`  ok  ${n}`); passed++; } catch (e) { console.log(`FAIL  ${n}\n${e.stack}`); process.exitCode = 1; } };

test("state follows earned, paid, ended, upcoming, full", () => {
  assert.strictEqual(questState(q(), now), "active");
  assert.strictEqual(questState(q({ earned: true }), now), "earned");
  assert.strictEqual(questState(q({ earned: true, paid: true }), now), "paid");
  assert.strictEqual(questState(q({ endsAt: h(-1) }), now), "ended");
  assert.strictEqual(questState(q({ startsAt: h(5) }), now), "upcoming");
  assert.strictEqual(questState(q({ quotaFull: true }), now), "full");
  assert.strictEqual(questState(q({ endsAt: h(-1), earned: true }), now), "earned", "an earned reward stays earned after the window");
});

test("progress is capped and an earned quest reads 100%", () => {
  assert.strictEqual(questProgressPct(q()), 40);
  assert.strictEqual(questProgressPct(q({ progress: 25 })), 100);
  assert.strictEqual(questProgressPct(q({ earned: true, progress: 3 })), 100);
  assert.strictEqual(questProgressPct(q({ targetTrips: 0 })), 0);
  assert.strictEqual(tripsLeft(q()), 6);
  assert.strictEqual(tripsLeft(q({ progress: 99 })), 0);
});

test("time left reads naturally", () => {
  assert.strictEqual(timeLeftLabel(h(72), now, t), "3 days left");
  assert.strictEqual(timeLeftLabel(h(5), now, t), "5 h left");
  assert.strictEqual(timeLeftLabel(h(1.2), now, t), "1 h left");
  assert.strictEqual(timeLeftLabel(new Date(now.getTime() + 30 * 60000).toISOString(), now, t), "30 min left");
  assert.strictEqual(timeLeftLabel(h(-1), now, t), "Ended");
});

test("rules state every condition a driver is held to", () => {
  const r = questRules(q({ minDriverRating: "4.50", tier: "comfort", minTripKm: "2.50" }), t).join(" ");
  assert.ok(r.includes("10 ArrivoExpress trips in comfort"));
  assert.ok(r.includes("2.5 km"));
  assert.ok(r.includes("same rider"));
  assert.ok(r.includes("4.5 or higher"));
  assert.ok(!questRules(q(), t).join(" ").includes("rating"));
});

test("the rules read in another language too", () => {
  const fr = (key, params) => translate(TRANSLATIONS, "fr", key, params);
  const r = questRules(q({ minDriverRating: "4.50" }), fr).join(" ");
  assert.ok(r.includes("Terminez 10 courses"));
  assert.ok(r.includes("4.5"));
});

test("sorting puts earnable quests first, ended last", () => {
  const list = [q({ id: 1, endsAt: h(-5) }), q({ id: 2, earned: true }), q({ id: 3, endsAt: h(10) }), q({ id: 4, endsAt: h(2) })];
  assert.deepStrictEqual(sortQuests(list, now).map((x) => x.id), [4, 3, 2, 1]);
});

console.log(`\n${passed} passed`);
