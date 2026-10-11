const assert = require("assert");
const { stripPhones, maskCounterpartyPhones } = require("./contactPrivacy");

let passed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.log(`FAIL  ${name}\n      ${e.message}`); process.exitCode = 1; }
}
const ride = () => ({ id: 9, rider_id: 1, rider_phone: "+2348011111111", driver_phone: "+2348022222222", rider_name: "Ada", emergency_contact_phone: "+2348033333333", pickup: "Ikoyi" });
const has = (o, k) => JSON.stringify(o).includes(`"${k}"`);

console.log("stripPhones:");
test("driver sees no rider phone, no emergency contact", () => {
  const o = stripPhones(ride(), { id: 2, role: "driver" });
  assert.ok(!has(o, "rider_phone") && !has(o, "driver_phone") && !has(o, "emergency_contact_phone"));
  assert.strictEqual(o.rider_name, "Ada"); assert.strictEqual(o.pickup, "Ikoyi");
});
test("rider sees no driver phone but keeps their own details", () => {
  const o = stripPhones(ride(), { id: 1, role: "rider" });
  assert.ok(!has(o, "driver_phone"));
  assert.strictEqual(o.rider_phone, "+2348011111111");
  assert.strictEqual(o.emergency_contact_phone, "+2348033333333");
});
test("a different rider sees none of it", () => {
  const o = stripPhones(ride(), { id: 5, role: "rider" });
  assert.ok(!has(o, "rider_phone") && !has(o, "driver_phone") && !has(o, "emergency_contact_phone"));
});
test("anonymous visitor sees none of it", () => {
  const o = stripPhones(ride(), null);
  assert.ok(!has(o, "rider_phone") && !has(o, "driver_phone"));
});
test("nested and arrays are cleaned", () => {
  const o = stripPhones({ rides: [ride(), { deep: { driver_whatsapp: "x", phone_number: "y", ok: 1 } }] }, { id: 2, role: "driver" });
  const s = JSON.stringify(o);
  assert.ok(!/driver_whatsapp|phone_number|rider_phone|driver_phone/.test(s));
  assert.ok(s.includes('"ok":1'));
});
test("does not mutate the original", () => {
  const r = ride(); stripPhones(r, null);
  assert.strictEqual(r.driver_phone, "+2348022222222");
});
test("dates, null and primitives pass through", () => {
  const d = new Date();
  const o = stripPhones({ at: d, n: null, s: "hi", k: 3, rider_id: 1 }, null);
  assert.strictEqual(o.at, d); assert.strictEqual(o.n, null); assert.strictEqual(o.s, "hi"); assert.strictEqual(o.k, 3);
});
test("a rider who is not the owner of an object cannot keep rider_phone by being a rider", () => {
  const o = stripPhones({ rider_id: 7, rider_phone: "123" }, { id: 1, role: "rider" });
  assert.ok(!has(o, "rider_phone"));
});

console.log("middleware:");
function run(user, body) {
  let sent; const res = { json(b) { sent = b; return this; } };
  const req = { user };
  maskCounterpartyPhones(req, res, () => {});
  res.json(body);
  return sent;
}
test("staff keep everything", () => {
  for (const role of ["admin", "support", "operations"]) assert.ok(has(run({ id: 99, role }, ride()), "driver_phone"));
});
test("driver and anonymous are stripped", () => {
  assert.ok(!has(run({ id: 2, role: "driver" }, ride()), "rider_phone"));
  assert.ok(!has(run(undefined, ride()), "driver_phone"));
});
test("user set after wrapping (requireAuth runs later) is honoured", () => {
  let sent; const res = { json(b) { sent = b; return this; } }; const req = {};
  maskCounterpartyPhones(req, res, () => {});
  req.user = { id: 99, role: "admin" };
  res.json(ride());
  assert.ok(has(sent, "driver_phone"));
});

test("co-riders' phones (shareParticipants) are hidden from the driver, kept for the owning rider, and a nested driver phone never is", () => {
  const r = { id: 9, rider_id: 1, shareParticipants: [{ id: 1, name: "Bola", phone: "+2348099999999" }], driver: { name: "Ibrahim", phone: "+2348055500123" } };
  const d = JSON.stringify(stripPhones(r, { id: 2, role: "driver" }));
  assert.ok(!/2348099999999|2348055500123/.test(d), d);
  const o = JSON.stringify(stripPhones(r, { id: 1, role: "rider" }));
  assert.ok(o.includes("2348099999999"), "owner keeps co-rider phone");
  assert.ok(!o.includes("2348055500123"), "owner never gets the driver phone");
  const other = JSON.stringify(stripPhones(r, { id: 3, role: "rider" }));
  assert.ok(!/2348099999999|2348055500123/.test(other));
});

console.log(`\n${passed} passed`);
