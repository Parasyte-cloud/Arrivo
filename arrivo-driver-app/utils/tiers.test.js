// Run directly: node utils/tiers.test.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "tiers.js"), "utf8");
assert.ok(!/^\s*import\s/m.test(src), "tiers.js has to stay import-free for this test to load it");
const names = "TIER_ORDER, TIER_FALLBACK, tierForRide, pickTier, sectionsFor, queueFor, metaFor, rowAction";
const { TIER_ORDER, TIER_FALLBACK, tierForRide, pickTier, sectionsFor, queueFor, metaFor, rowAction } = new Function(
  src.replace(/^export (const|function) /gm, "$1 ") + `\nreturn { ${names} };`
)();

let passed = 0;
const test = (n, f) => { try { f(); console.log(`  ok  ${n}`); passed++; } catch (e) { console.log(`FAIL  ${n}\n${e.stack}`); process.exitCode = 1; } };

test("every tier has a name, a tagline and an accent", () => {
  assert.strictEqual(TIER_ORDER.length, 7);
  for (const t of TIER_ORDER) {
    assert.ok(TIER_FALLBACK[t].name && TIER_FALLBACK[t].tagline && /^#[0-9A-F]{6}$/i.test(TIER_FALLBACK[t].accent), t);
    assert.ok(!/\u2014/.test(JSON.stringify(TIER_FALLBACK[t])), "no em dash");
  }
});

test("rides map to a tier the way the server does", () => {
  for (const b of ["one_way", "dropoff", undefined, "", "anything_else"]) assert.strictEqual(tierForRide({ booking_type: b }), "ride", String(b));
  for (const b of ["full_day", "full_week", "full_month", "FULL_DAY"]) assert.strictEqual(tierForRide({ booking_type: b }), "chauffeur", b);
  assert.strictEqual(tierForRide(null), "ride");
});

test("the chosen tier is kept while held, else the first held in order", () => {
  assert.strictEqual(pickTier(["express", "ride"], "express"), "express");
  assert.strictEqual(pickTier(["express", "ride"], "chauffeur"), "ride");
  assert.strictEqual(pickTier(["express", "ride"], null), "ride");
  assert.strictEqual(pickTier(["campus"], "ride"), "campus");
  assert.strictEqual(pickTier([], "ride"), null);
  assert.strictEqual(pickTier(undefined, undefined), null);
});

test("each tier shows only its own section", () => {
  assert.deepStrictEqual(sectionsFor("express"), { express: true, queue: false, pane: false, queueTier: null });
  assert.deepStrictEqual(sectionsFor("ride"), { express: false, queue: true, pane: false, queueTier: "ride" });
  assert.deepStrictEqual(sectionsFor("chauffeur"), { express: false, queue: true, pane: false, queueTier: "chauffeur" });
  for (const t of ["campus", "air", "boat", "removals", null]) {
    const s = sectionsFor(t);
    assert.strictEqual(s.express, false, String(t));
    assert.strictEqual(s.queue, false, String(t));
    assert.strictEqual(s.pane, true, String(t));
  }
});

test("an older server with no tiers keeps the old single screen", () => {
  assert.deepStrictEqual(sectionsFor(null, { legacy: true }), { express: true, queue: true, pane: false, queueTier: null });
});

test("the queue never mixes airport rides and charters", () => {
  const rides = [{ id: 1, booking_type: "one_way" }, { id: 2, booking_type: "full_day" }, { id: 3, booking_type: "dropoff" }];
  assert.deepStrictEqual(queueFor(rides, "ride").map((r) => r.id), [1, 3]);
  assert.deepStrictEqual(queueFor(rides, "chauffeur").map((r) => r.id), [2]);
  assert.strictEqual(queueFor(rides, null).length, 3);
  assert.deepStrictEqual(queueFor(undefined, "ride"), []);
});

test("tier details come from the server when it sends them", () => {
  assert.strictEqual(metaFor("air", []).name, "ArrivoAir");
  assert.strictEqual(metaFor("air", [{ slug: "air", name: "ArrivoAir Plus" }]).name, "ArrivoAir Plus");
  assert.strictEqual(metaFor("zzz", []).name, "zzz");
});

test("a driver can ask only when a service is off or was withdrawn", () => {
  assert.strictEqual(rowAction("active").kind, "none");
  assert.strictEqual(rowAction("requested").kind, "none");
  assert.strictEqual(rowAction("off").kind, "ask");
  assert.strictEqual(rowAction("revoked").kind, "ask");
});

console.log(`\ntiers: ${passed} passed`);
