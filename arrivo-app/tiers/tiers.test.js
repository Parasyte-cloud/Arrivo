// Tests for the tier registry and the request form rules. Run directly:
//   node tiers/tiers.test.js
//
// Both modules are import-free, so they are evaluated without a bundler.

const assert = require("assert");
const fs = require("fs");
const path = require("path");

function load(file, names) {
  const src = fs.readFileSync(path.join(__dirname, file), "utf8");
  assert.ok(!/^\s*import\s/m.test(src), `${file} has to stay import-free for this test to load it`);
  assert.ok(!src.includes(String.fromCharCode(0x2014)), `no em dash in ${file}`);
  return new Function(src.replace(/^export const /gm, "const ").replace(/^export function /gm, "function ") + `\nreturn { ${names} };`)();
}

const R = load("registry.js", "TIER_ORDER, TIERS, getTier, visibleTiers, pickStartTier");
const Q = load(
  "requestTiers.js",
  "REQUEST_TIER_IDS, REQUEST_TIERS, validateRequest, statusInfo, canCancel, isOpen, formatNaira, optionLabel, REQUEST_STATUS, MAX_ADVANCE_DAYS, MAX_DETAILS_LENGTH, MAX_ADDRESS_LENGTH, PAST_GRACE_MS"
);

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

console.log("Registry:");

test("there are exactly six tiers, named as the business names them", () => {
  assert.deepStrictEqual(
    R.TIER_ORDER.map((id) => R.TIERS[id].label),
    ["RideArrivo", "ArrivoExpress", "ArrivoChauffer", "ArrivoAir", "ArrivoBoat", "ArrivoRemovals"]
  );
});

test("every tier has what the shell needs and a unique id", () => {
  const ids = new Set();
  for (const id of R.TIER_ORDER) {
    const t = R.TIERS[id];
    assert.strictEqual(t.id, id);
    assert.ok(t.label && t.short && t.tagline && t.icon, id);
    assert.ok(["flow", "request"].includes(t.kind), id);
    assert.ok(t.tagline.length <= 70, `${id} tagline is a short line`);
    ids.add(t.id);
  }
  assert.strictEqual(ids.size, 6);
  assert.deepStrictEqual(Object.keys(R.TIERS).sort(), [...R.TIER_ORDER].sort());
});

test("the request tiers in the registry are the ones the request form handles", () => {
  const fromRegistry = R.TIER_ORDER.filter((id) => R.TIERS[id].kind === "request");
  assert.deepStrictEqual(fromRegistry.sort(), [...Q.REQUEST_TIER_IDS].sort());
});

test("getTier finds a tier and returns null for nonsense", () => {
  assert.strictEqual(R.getTier("air").label, "ArrivoAir");
  assert.strictEqual(R.getTier("nope"), null);
  assert.strictEqual(R.getTier(undefined), null);
});

test("ArrivoExpress stays hidden until its flag is on, all others always show", () => {
  const off = R.visibleTiers({}).map((t) => t.id);
  assert.ok(!off.includes("express"));
  assert.strictEqual(off.length, 5);
  assert.deepStrictEqual(R.visibleTiers(undefined).map((t) => t.id), off);
  assert.ok(!R.visibleTiers({ expressEnabled: false }).some((t) => t.id === "express"));
  assert.ok(!R.visibleTiers({ expressEnabled: "yes" }).some((t) => t.id === "express"), "only a real true counts");
  const on = R.visibleTiers({ expressEnabled: true }).map((t) => t.id);
  assert.deepStrictEqual(on, R.TIER_ORDER);
});

test("order is stable: RideArrivo first", () => {
  assert.strictEqual(R.visibleTiers({})[0].id, "ride");
});

test("pickStartTier reopens the last tier only if it is still available", () => {
  assert.strictEqual(R.pickStartTier("boat", {}), "boat");
  assert.strictEqual(R.pickStartTier("express", { expressEnabled: true }), "express");
  assert.strictEqual(R.pickStartTier("express", {}), "ride");
  assert.strictEqual(R.pickStartTier("garbage", {}), "ride");
  assert.strictEqual(R.pickStartTier(undefined, undefined), "ride");
  assert.strictEqual(R.pickStartTier(null, {}), "ride");
});

console.log("Request form:");

const NOW = new Date("2026-10-24T12:00:00Z").getTime();
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const later = (ms) => new Date(NOW + ms);

const good = {
  air: () => ({ pickupAddress: "Lagos Heliport", destinationAddress: "Abuja", when: later(5 * HOUR), passengerCount: "3", option: "helicopter", contactPhone: "+2348012345678", details: "" }),
  boat: () => ({ pickupAddress: "Falomo Jetty", destinationAddress: "Lekki", when: later(2 * DAY), passengerCount: "8", option: "speedboat", contactPhone: "+2348012345678" }),
  removals: () => ({ pickupAddress: "Lekki", destinationAddress: "Ikoyi", when: later(3 * DAY), option: "two_bed", crewSize: 4, contactPhone: "+2348012345678" }),
};

test("a complete form is accepted for each tier and builds the server payload", () => {
  for (const id of Q.REQUEST_TIER_IDS) {
    const r = Q.validateRequest(id, good[id](), NOW);
    assert.ok(r.ok, JSON.stringify(r.errors));
    assert.strictEqual(r.payload.tier, id);
    assert.ok(/^\d{4}-\d\d-\d\dT.*Z$/.test(r.payload.requestedAt));
  }
});

test("payload shape matches what the server expects", () => {
  const p = Q.validateRequest("air", good.air(), NOW).payload;
  assert.deepStrictEqual(Object.keys(p).sort(), ["contactPhone", "crewSize", "destinationAddress", "details", "option", "passengerCount", "pickupAddress", "requestedAt", "tier"]);
  assert.strictEqual(p.passengerCount, 3);
  assert.strictEqual(p.crewSize, null);
  assert.strictEqual(p.details, undefined);
});

test("removals sends a passenger count of 1 and its crew size", () => {
  const p = Q.validateRequest("removals", good.removals(), NOW).payload;
  assert.strictEqual(p.passengerCount, 1);
  assert.strictEqual(p.crewSize, 4);
});

test("an empty form reports every missing field by name, never throws", () => {
  for (const id of Q.REQUEST_TIER_IDS) {
    const r = Q.validateRequest(id, {}, NOW);
    assert.ok(!r.ok && r.payload === null);
    for (const f of ["pickupAddress", "destinationAddress", "when", "option", "contactPhone"]) assert.ok(r.errors[f], `${id} ${f}`);
  }
  assert.ok(Q.validateRequest("air", undefined, NOW).errors.pickupAddress);
  assert.ok(Q.validateRequest("express", good.air(), NOW).errors.tier);
});

test("messages are plain sentences with no em dash", () => {
  const all = [];
  for (const id of Q.REQUEST_TIER_IDS) all.push(...Object.values(Q.validateRequest(id, {}, NOW).errors));
  for (const m of all) {
    assert.ok(m.length > 5 && m.length < 80, m);
    assert.ok(!m.includes(String.fromCharCode(0x2014)), m);
  }
});

test("time: past, too far ahead, nonsense and a small grace window", () => {
  assert.ok(Q.validateRequest("air", { ...good.air(), when: later(-HOUR) }, NOW).errors.when);
  assert.ok(!Q.validateRequest("air", { ...good.air(), when: later(-5 * 60 * 1000) }, NOW).errors.when);
  assert.ok(Q.validateRequest("air", { ...good.air(), when: later((Q.MAX_ADVANCE_DAYS + 1) * DAY) }, NOW).errors.when);
  assert.ok(Q.validateRequest("air", { ...good.air(), when: "garbage" }, NOW).errors.when);
  assert.ok(Q.validateRequest("air", { ...good.air(), when: null }, NOW).errors.when);
  assert.ok(!Q.validateRequest("air", { ...good.air(), when: later(5 * HOUR).toISOString() }, NOW).errors.when, "ISO strings work too");
});

test("passengers: whole numbers within each tier's limit", () => {
  const air = (n) => Q.validateRequest("air", { ...good.air(), passengerCount: n }, NOW).errors.passengerCount;
  assert.ok(air("0") && air("21") && air("1.5") && air("abc") && air(""));
  assert.ok(!air("1") && !air("20"));
  const boat = (n) => Q.validateRequest("boat", { ...good.boat(), passengerCount: n }, NOW).errors.passengerCount;
  assert.ok(boat("61"));
  assert.ok(!boat("60"));
});

test("options must belong to the tier", () => {
  assert.ok(Q.validateRequest("air", { ...good.air(), option: "yacht" }, NOW).errors.option);
  assert.ok(Q.validateRequest("boat", { ...good.boat(), option: "helicopter" }, NOW).errors.option);
  assert.ok(Q.validateRequest("removals", { ...good.removals(), option: "speedboat" }, NOW).errors.option);
  for (const id of Q.REQUEST_TIER_IDS) for (const o of Q.REQUEST_TIERS[id].options) assert.ok(Q.validateRequest(id, { ...good[id](), option: o.value }, NOW).ok);
});

test("crew size only matters for removals and must be one of the offered sizes", () => {
  assert.ok(Q.validateRequest("removals", { ...good.removals(), crewSize: 3 }, NOW).errors.crewSize);
  assert.ok(Q.validateRequest("removals", { ...good.removals(), crewSize: undefined }, NOW).errors.crewSize);
  for (const c of Q.REQUEST_TIERS.removals.crewSizes) assert.ok(Q.validateRequest("removals", { ...good.removals(), crewSize: c }, NOW).ok);
  assert.ok(Q.validateRequest("boat", { ...good.boat(), crewSize: 9 }, NOW).ok);
});

test("phone needs the country code", () => {
  const phone = (p) => Q.validateRequest("air", { ...good.air(), contactPhone: p }, NOW).errors.contactPhone;
  assert.ok(phone("08012345678") && phone("") && phone("+0123456789") && phone("+234") && phone("abc") && phone("+23480123456789012345"));
  assert.ok(!phone("+2348012345678") && !phone("  +2348012345678  ") && !phone("+447911123456"));
});

test("long text is refused, surrounding space is trimmed", () => {
  assert.ok(Q.validateRequest("air", { ...good.air(), details: "x".repeat(Q.MAX_DETAILS_LENGTH + 1) }, NOW).errors.details);
  assert.ok(Q.validateRequest("air", { ...good.air(), pickupAddress: "x".repeat(Q.MAX_ADDRESS_LENGTH + 1) }, NOW).errors.pickupAddress);
  assert.ok(Q.validateRequest("air", { ...good.air(), pickupAddress: "   " }, NOW).errors.pickupAddress);
  assert.strictEqual(Q.validateRequest("air", { ...good.air(), pickupAddress: "  Heliport  ", details: " bags " }, NOW).payload.pickupAddress, "Heliport");
  assert.strictEqual(Q.validateRequest("air", { ...good.air(), details: " bags " }, NOW).payload.details, "bags");
});

test("every tier has its three step explanation and labels the form needs", () => {
  for (const id of Q.REQUEST_TIER_IDS) {
    const t = Q.REQUEST_TIERS[id];
    assert.strictEqual(t.steps.length, 3, id);
    for (const k of ["label", "cta", "pickupLabel", "destinationLabel", "whenLabel", "optionLabel", "detailsHint"]) assert.ok(t[k], `${id}.${k}`);
    assert.ok(t.options.length >= 2);
  }
});

console.log("Request status:");

test("each status reads clearly and steps run forward", () => {
  const order = ["pending", "confirmed", "in_progress", "completed"];
  const steps = order.map((s) => Q.statusInfo(s).step);
  assert.deepStrictEqual(steps, [1, 2, 3, 4]);
  for (const s of Object.keys(Q.REQUEST_STATUS)) assert.ok(Q.statusInfo(s).label && Q.statusInfo(s).detail);
  assert.strictEqual(Q.statusInfo("cancelled").step, 0);
  assert.strictEqual(Q.statusInfo("???").label, "Unknown");
});

test("the rider can cancel until the trip starts, and open means still moving", () => {
  assert.ok(Q.canCancel("pending") && Q.canCancel("confirmed"));
  assert.ok(!Q.canCancel("in_progress") && !Q.canCancel("completed") && !Q.canCancel("cancelled") && !Q.canCancel(undefined));
  assert.ok(Q.isOpen("pending") && Q.isOpen("confirmed") && Q.isOpen("in_progress"));
  assert.ok(!Q.isOpen("completed") && !Q.isOpen("cancelled"));
});

test("naira is formatted with separators and handles bad input", () => {
  assert.strictEqual(Q.formatNaira(120000), "₦120,000");
  assert.strictEqual(Q.formatNaira(999), "₦999");
  assert.strictEqual(Q.formatNaira(1500000), "₦1,500,000");
  assert.strictEqual(Q.formatNaira(null), "", "no price yet is blank, never a free trip");
  assert.strictEqual(Q.formatNaira(""), "");
  assert.strictEqual(Q.formatNaira(0), "₦0");
  assert.strictEqual(Q.formatNaira("abc"), "");
  assert.strictEqual(Q.formatNaira(undefined), "");
});

test("option labels fall back to the raw value", () => {
  assert.strictEqual(Q.optionLabel("air", "private_jet"), "Private jet");
  assert.strictEqual(Q.optionLabel("removals", "three_plus_bed"), "3+ bedroom");
  assert.strictEqual(Q.optionLabel("air", "weird"), "weird");
  assert.strictEqual(Q.optionLabel("nope", "x"), "x");
});

console.log(`\n${passed} passed`);
