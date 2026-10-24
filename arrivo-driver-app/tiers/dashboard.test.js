// Tests for the dashboard wording rules. Run directly:  node tiers/dashboard.test.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "dashboard.js"), "utf8");
assert.ok(!/^\s*import\s/m.test(src), "dashboard.js has to stay import-free");
assert.ok(!src.includes(String.fromCharCode(0x2014)), "no em dash in dashboard.js");
const D = new Function(
  src.replace(/^export function /gm, "function ") +
    "\nreturn { naira, timeLeftLabel, isExpired, canReceiveOrders, subscriptionView, inspectionView, dayLabel, tripsLabel, isPlausibleReference };"
)();

let passed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passed++; } catch (e) { console.log(`FAIL  ${name}\n      ${e.message}`); process.exitCode = 1; }
}

const T0 = Date.parse("2026-10-24T10:00:00Z");
const END = "2026-10-24T23:00:00.000Z"; // 00:00 Lagos
const active = { active: true, enforced: true, priceNaira: 2000, endsAt: END };
const inactive = { active: false, enforced: true, priceNaira: 2000, endsAt: null };

test("naira formats and survives bad input", () => {
  assert.equal(D.naira(2000), "₦2,000");
  assert.equal(D.naira(1234567), "₦1,234,567");
  assert.equal(D.naira(0), "₦0");
  assert.equal(D.naira(null), "");
  assert.equal(D.naira("abc"), "");
});

test("time left counts down to Lagos midnight", () => {
  assert.equal(D.timeLeftLabel(END, T0), "13h 0m left");
  assert.equal(D.timeLeftLabel(END, Date.parse(END) - 45 * 60000), "45m left");
  assert.equal(D.timeLeftLabel(END, Date.parse(END) - 20000), "Under a minute left");
  assert.equal(D.timeLeftLabel(END, Date.parse(END)), "");
  assert.equal(D.timeLeftLabel(null, T0), "");
  assert.equal(D.timeLeftLabel("junk", T0), "");
});

test("a subscription flips to expired exactly at midnight", () => {
  assert.equal(D.isExpired(active, Date.parse(END) - 1), false);
  assert.equal(D.isExpired(active, Date.parse(END)), true);
  assert.equal(D.isExpired(inactive, T0), false);
  assert.equal(D.isExpired(null, T0), false);
});

test("orders flow only while subscribed", () => {
  assert.equal(D.canReceiveOrders(active, T0), true);
  assert.equal(D.canReceiveOrders(active, Date.parse(END)), false);
  assert.equal(D.canReceiveOrders(inactive, T0), false);
  assert.equal(D.canReceiveOrders(null, T0), false);
  assert.equal(D.canReceiveOrders({ ...inactive, enforced: false }, T0), true);
});

test("unsubscribed driver is told to subscribe, in red, with one button", () => {
  const v = D.subscriptionView(inactive, T0);
  assert.equal(v.state, "inactive");
  assert.equal(v.tone, "red");
  assert.equal(v.button, "Subscribe ₦2,000");
  assert.match(v.detail, /12am/);
  assert.match(v.detail, /₦2,000/);
});

test("subscribed driver sees status and no button", () => {
  const v = D.subscriptionView(active, T0);
  assert.equal(v.state, "active");
  assert.equal(v.tone, "ok");
  assert.equal(v.button, null);
  assert.match(v.detail, /13h 0m left/);
});

test("after midnight the same data reads as unsubscribed", () => {
  const v = D.subscriptionView(active, Date.parse(END) + 1000);
  assert.equal(v.state, "inactive");
  assert.ok(v.button);
});

test("unknown and not-enforced states never show a pay button", () => {
  assert.equal(D.subscriptionView(null, T0).button, null);
  const free = D.subscriptionView({ ...inactive, enforced: false }, T0);
  assert.equal(free.state, "free");
  assert.equal(free.button, null);
});

test("price comes from the server answer", () => {
  assert.equal(D.subscriptionView({ ...inactive, priceNaira: 2500 }, T0).button, "Subscribe ₦2,500");
});

test("inspection banner is red only when action is needed", () => {
  assert.equal(D.inspectionView(null), null);
  assert.equal(D.inspectionView({ state: "ok", severity: "none", message: "" }), null);
  const soon = D.inspectionView({ state: "due_soon", severity: "red", dueOn: "2026-10-24", message: "Inspection due in 7 days. Please book your visit." });
  assert.equal(soon.tone, "red");
  assert.equal(soon.title, "Inspection coming up");
  assert.equal(D.inspectionView({ state: "overdue", severity: "red", message: "x" }).title, "Inspection overdue");
  assert.equal(D.inspectionView({ state: "due_today", severity: "red", message: "x" }).title, "Inspection due today");
  assert.equal(D.inspectionView({ state: "not_recorded", severity: "red", message: "x" }).title, "Inspection needed");
});

test("day and trip labels", () => {
  assert.equal(D.dayLabel("2026-10-24"), "24 Oct 2026");
  assert.equal(D.dayLabel("2026-01-05"), "5 Jan 2026");
  assert.equal(D.dayLabel("nope"), "");
  assert.equal(D.dayLabel(null), "");
  assert.equal(D.tripsLabel(0), "0 trips");
  assert.equal(D.tripsLabel(1), "1 trip");
  assert.equal(D.tripsLabel(12), "12 trips");
  assert.equal(D.tripsLabel(undefined), "0 trips");
});

test("only plain payment references are kept for later", () => {
  assert.equal(D.isPlausibleReference("abc123XYZ"), true);
  assert.equal(D.isPlausibleReference("../123456"), false);
  assert.equal(D.isPlausibleReference("a b"), false);
  assert.equal(D.isPlausibleReference(null), false);
});

console.log(`\n${passed} passed`);
