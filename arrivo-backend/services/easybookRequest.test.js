// Tests for the EasyBook validator and the invoice/receipt email content.
//   node services/easybookRequest.test.js
// Pure functions, no database or network.

const assert = require("assert");
const { validateTrip, validateContact, validateSubmission } = require("./easybookRequest");
const { tripRows } = require("./email");

const NOW = Date.parse("2026-11-17T10:00:00Z");
const inDays = (d) => new Date(NOW + d * 86400000).toISOString();

const contact = { name: "Ada Obi", email: "Ada@Example.com", phone: "+2348012345678" };
const oneWay = { bookingType: "one_way", vehicleType: "sedan", pickupAddress: "Murtala Muhammed Airport", destinationAddress: "Eko Hotel, Victoria Island", flightNumber: "BA75" };

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log("ok -", name);
}

test("airport pickup needs a flight number", () => {
  const r = validateTrip({ ...oneWay, flightNumber: "" }, { now: NOW });
  assert.strictEqual(r.ok, false);
  assert.match(r.body.error, /flight number/i);
});

test("airport pickup is valid without a date", () => {
  const r = validateTrip(oneWay, { now: NOW });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.value.scheduledPickupAt, null);
  assert.strictEqual(r.value.passengerCount, 1);
});

test("airport drop-off requires a pickup time", () => {
  const r = validateTrip({ ...oneWay, bookingType: "dropoff", flightNumber: "" }, { now: NOW });
  assert.strictEqual(r.ok, false);
  assert.match(r.body.error, /pickup date and time/i);
});

test("airport drop-off with a time 5 days out is valid", () => {
  const r = validateTrip({ ...oneWay, bookingType: "dropoff", flightNumber: "", scheduledPickupAt: inDays(5) }, { now: NOW });
  assert.strictEqual(r.ok, true);
});

test("a pickup inside the 3 hour window is blocked with the WhatsApp fallback", () => {
  const soon = new Date(NOW + 60 * 60 * 1000).toISOString();
  const r = validateTrip({ ...oneWay, bookingType: "dropoff", scheduledPickupAt: soon }, { now: NOW });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.body.blockedByBookingWindow, true);
  assert.ok(r.body.whatsappNumber);
});

test("a pickup in the past is refused", () => {
  const r = validateTrip({ ...oneWay, bookingType: "dropoff", scheduledPickupAt: inDays(-1) }, { now: NOW });
  assert.strictEqual(r.ok, false);
  assert.match(r.body.error, /future/i);
});

test("chauffeur by the day needs a start time but no drop-off", () => {
  const base = { bookingType: "full_day", vehicleType: "suv", pickupAddress: "Lekki Phase 1" };
  assert.strictEqual(validateTrip(base, { now: NOW }).ok, false);
  const ok = validateTrip({ ...base, scheduledPickupAt: inDays(4), durationDays: 3 }, { now: NOW });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.value.durationDays, 3);
  assert.strictEqual(ok.value.destinationAddress, null);
});

test("week and month charters ignore a client durationDays", () => {
  const r = validateTrip({ bookingType: "full_week", vehicleType: "sedan", pickupAddress: "Ikoyi", scheduledPickupAt: inDays(6), durationDays: 99 }, { now: NOW });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.value.durationDays, 1);
});

test("ArrivoExpress and unknown trip types are refused", () => {
  for (const t of ["express", "arrivo_express", "fleet", ""]) {
    assert.strictEqual(validateTrip({ ...oneWay, bookingType: t }, { now: NOW }).ok, false);
  }
});

test("fleet size is never accepted from the client", () => {
  const r = validateTrip({ ...oneWay, fleetSize: 3 }, { now: NOW });
  assert.strictEqual(r.value.fleetSize, 0);
});

test("passenger counts are bounded and summed", () => {
  assert.strictEqual(validateTrip({ ...oneWay, adults: 0 }, { now: NOW }).ok, false);
  assert.strictEqual(validateTrip({ ...oneWay, adults: 2.5 }, { now: NOW }).ok, false);
  const r = validateTrip({ ...oneWay, adults: 2, children: 3 }, { now: NOW });
  assert.strictEqual(r.value.passengerCount, 5);
});

test("contact: email is lowercased, bad email and bad phone refused", () => {
  const ok = validateContact(contact);
  assert.strictEqual(ok.value.email, "ada@example.com");
  assert.strictEqual(validateContact({ ...contact, email: "nope" }).ok, false);
  assert.strictEqual(validateContact({ ...contact, phone: "123" }).ok, false);
  assert.strictEqual(validateContact({ ...contact, name: "A" }).ok, false);
});

test("submission requires the cancellation policy agreement", () => {
  const body = { ...contact, ...oneWay };
  assert.strictEqual(validateSubmission(body, { now: NOW }).ok, false);
  const ok = validateSubmission({ ...body, agreedCancellationPolicy: true, helperName: "  Tola  " }, { now: NOW });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.value.helperName, "Tola");
});

test("invoice trip rows read well for each trip type", () => {
  const rows = tripRows({ bookingType: "full_day", vehicleType: "suv", pickupAddress: "Lekki", durationDays: 3, adults: 2, children: 1, scheduledPickupAt: inDays(4), luxury: true });
  const labels = rows.map((r) => r[0]);
  assert.ok(labels.includes("Meet at") && labels.includes("Days") && labels.includes("Starts"));
  assert.deepStrictEqual(rows.find((r) => r[0] === "Passengers"), ["Passengers", "3"]);
});

console.log(`\n${passed} passed`);
