// Tests for the ArrivoAir / ArrivoBoat / ArrivoRemovals request rules. Run directly:
//   node services/serviceRequests.test.js

const assert = require("assert");
const svc = require("./serviceRequests");

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

const NOW = new Date("2026-10-24T12:00:00Z").getTime();
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const iso = (ms) => new Date(NOW + ms).toISOString();

const air = () => ({
  tier: "air", pickupAddress: "Lagos Heliport, VI", destinationAddress: "Abuja", requestedAt: iso(5 * HOUR),
  passengerCount: 3, option: "helicopter", contactPhone: "+2348012345678",
});
const boat = () => ({
  tier: "boat", pickupAddress: "Falomo Jetty", destinationAddress: "Lekki Beach", requestedAt: iso(2 * DAY),
  passengerCount: 8, option: "speedboat", contactPhone: "+2348012345678",
});
const removals = () => ({
  tier: "removals", pickupAddress: "12 Admiralty Way, Lekki", destinationAddress: "4 Banana Island Rd, Ikoyi", requestedAt: iso(3 * DAY),
  option: "two_bed", crewSize: 4, contactPhone: "+2348012345678",
});

console.log("Service requests, create:");

test("a good request for each tier is accepted", () => {
  for (const make of [air, boat, removals]) {
    const r = svc.parseCreate(make(), NOW);
    assert.ok(r.value, JSON.stringify(r));
  }
});

test("the three tiers are exactly air, boat and removals", () => {
  assert.deepStrictEqual(svc.TIER_KEYS, ["air", "boat", "removals"]);
});

test("unknown or missing tier is rejected", () => {
  assert.ok(svc.parseCreate({ ...air(), tier: "express" }, NOW).error);
  assert.ok(svc.parseCreate({ ...air(), tier: undefined }, NOW).error);
  assert.ok(svc.parseCreate(undefined, NOW).error);
});

test("addresses are required, trimmed and length limited", () => {
  assert.ok(svc.parseCreate({ ...air(), pickupAddress: "   " }, NOW).error);
  assert.ok(svc.parseCreate({ ...air(), destinationAddress: "" }, NOW).error);
  assert.strictEqual(svc.parseCreate({ ...air(), pickupAddress: "  Heliport  " }, NOW).value.pickupAddress, "Heliport");
  assert.ok(svc.parseCreate({ ...air(), pickupAddress: "x".repeat(svc.MAX_ADDRESS_LENGTH + 1) }, NOW).error);
  assert.ok(svc.parseCreate({ ...air(), pickupAddress: "x".repeat(svc.MAX_ADDRESS_LENGTH) }, NOW).value);
});

test("time must be present, valid, not past, not too far ahead", () => {
  assert.ok(svc.parseCreate({ ...air(), requestedAt: undefined }, NOW).error);
  assert.ok(svc.parseCreate({ ...air(), requestedAt: "soon" }, NOW).error);
  assert.ok(svc.parseCreate({ ...air(), requestedAt: 12345 }, NOW).error);
  assert.ok(svc.parseCreate({ ...air(), requestedAt: iso(-HOUR) }, NOW).error);
  assert.ok(svc.parseCreate({ ...air(), requestedAt: iso(svc.MAX_ADVANCE_DAYS * DAY + HOUR) }, NOW).error);
});

test("a few minutes in the past is forgiven, an offset time is normalised", () => {
  assert.ok(svc.parseCreate({ ...air(), requestedAt: iso(-5 * 60 * 1000) }, NOW).value);
  const r = svc.parseCreate({ ...air(), requestedAt: "2026-10-24T18:00:00+01:00" }, NOW);
  assert.strictEqual(r.value.requestedAt, "2026-10-24T17:00:00.000Z");
});

test("passengers: whole number within the tier limit", () => {
  assert.ok(svc.parseCreate({ ...air(), passengerCount: 0 }, NOW).error);
  assert.ok(svc.parseCreate({ ...air(), passengerCount: 21 }, NOW).error);
  assert.ok(svc.parseCreate({ ...air(), passengerCount: 2.5 }, NOW).error);
  assert.ok(svc.parseCreate({ ...air(), passengerCount: "abc" }, NOW).error);
  assert.ok(svc.parseCreate({ ...air(), passengerCount: 20 }, NOW).value);
  assert.ok(svc.parseCreate({ ...boat(), passengerCount: 61 }, NOW).error);
  assert.ok(svc.parseCreate({ ...boat(), passengerCount: 60 }, NOW).value);
});

test("removals does not ask for passengers and stores 1", () => {
  const r = svc.parseCreate(removals(), NOW);
  assert.strictEqual(r.value.passengerCount, 1);
});

test("option is required and must belong to the tier", () => {
  assert.ok(svc.parseCreate({ ...air(), option: undefined }, NOW).error);
  assert.ok(svc.parseCreate({ ...air(), option: "speedboat" }, NOW).error);
  assert.ok(svc.parseCreate({ ...boat(), option: "helicopter" }, NOW).error);
  assert.ok(svc.parseCreate({ ...removals(), option: "private_jet" }, NOW).error);
  for (const o of svc.TIERS.air.options) assert.ok(svc.parseCreate({ ...air(), option: o }, NOW).value);
  for (const o of svc.TIERS.boat.options) assert.ok(svc.parseCreate({ ...boat(), option: o }, NOW).value);
  for (const o of svc.TIERS.removals.options) assert.ok(svc.parseCreate({ ...removals(), option: o }, NOW).value);
});

test("removals needs a valid crew size, the others ignore it", () => {
  assert.ok(svc.parseCreate({ ...removals(), crewSize: undefined }, NOW).error);
  assert.ok(svc.parseCreate({ ...removals(), crewSize: 3 }, NOW).error);
  for (const c of [2, 4, 6]) assert.strictEqual(svc.parseCreate({ ...removals(), crewSize: c }, NOW).value.crewSize, c);
  assert.strictEqual(svc.parseCreate({ ...air(), crewSize: 4 }, NOW).value.crewSize, null);
});

test("contact phone must be present and in international format", () => {
  assert.ok(svc.parseCreate({ ...air(), contactPhone: "" }, NOW).error);
  assert.ok(svc.parseCreate({ ...air(), contactPhone: "08012345678" }, NOW).error);
  assert.ok(svc.parseCreate({ ...air(), contactPhone: undefined }, NOW).error);
  assert.strictEqual(svc.parseCreate({ ...air(), contactPhone: " +2348012345678 " }, NOW).value.contactPhone, "+2348012345678");
});

test("details are optional, trimmed and length limited", () => {
  assert.strictEqual(svc.parseCreate(air(), NOW).value.details, null);
  assert.strictEqual(svc.parseCreate({ ...air(), details: "   " }, NOW).value.details, null);
  assert.strictEqual(svc.parseCreate({ ...air(), details: " 2 bags " }, NOW).value.details, "2 bags");
  assert.ok(svc.parseCreate({ ...air(), details: "x".repeat(svc.MAX_DETAILS_LENGTH + 1) }, NOW).error);
});

test("idempotency key is optional and limited", () => {
  assert.strictEqual(svc.parseCreate(air(), NOW).value.idempotencyKey, null);
  assert.strictEqual(svc.parseCreate({ ...air(), idempotencyKey: " abc " }, NOW).value.idempotencyKey, "abc");
  assert.ok(svc.parseCreate({ ...air(), idempotencyKey: "k".repeat(81) }, NOW).error);
});

console.log("Service requests, confirm:");

test("confirm needs a sensible fare and a driver", () => {
  assert.deepStrictEqual(svc.parseConfirm({ fareNaira: 250000, driverId: 7 }).value, { fareNaira: 250000, driverId: 7 });
  assert.ok(svc.parseConfirm({ fareNaira: 999, driverId: 7 }).error);
  assert.ok(svc.parseConfirm({ fareNaira: 1000.5, driverId: 7 }).error);
  assert.ok(svc.parseConfirm({ fareNaira: "lots", driverId: 7 }).error);
  assert.ok(svc.parseConfirm({ fareNaira: 5000 }).error);
  assert.ok(svc.parseConfirm({ fareNaira: 5000, driverId: 0 }).error);
  assert.ok(svc.parseConfirm(undefined).error);
});

console.log("Service requests, status rules:");

test("rider can cancel only before the trip starts", () => {
  assert.ok(svc.canTransition("rider", "pending", "cancelled"));
  assert.ok(svc.canTransition("rider", "confirmed", "cancelled"));
  assert.ok(!svc.canTransition("rider", "in_progress", "cancelled"));
  assert.ok(!svc.canTransition("rider", "completed", "cancelled"));
  assert.ok(!svc.canTransition("rider", "pending", "completed"));
});

test("driver can start a confirmed job and finish a started one, nothing else", () => {
  assert.ok(svc.canTransition("driver", "confirmed", "in_progress"));
  assert.ok(svc.canTransition("driver", "in_progress", "completed"));
  assert.ok(!svc.canTransition("driver", "confirmed", "completed"), "cannot skip the start");
  assert.ok(!svc.canTransition("driver", "pending", "in_progress"), "cannot take an unconfirmed request");
  assert.ok(!svc.canTransition("driver", "in_progress", "cancelled"));
  assert.ok(!svc.canTransition("driver", "completed", "in_progress"));
});

test("staff can cancel anything that is not finished", () => {
  for (const from of ["pending", "confirmed", "in_progress"]) assert.ok(svc.canTransition("staff", from, "cancelled"));
  assert.ok(!svc.canTransition("staff", "completed", "cancelled"));
  assert.ok(!svc.canTransition("staff", "cancelled", "cancelled"));
});

test("unknown actors and statuses are refused", () => {
  assert.ok(!svc.canTransition("hacker", "pending", "cancelled"));
  assert.ok(!svc.canTransition("rider", "nonsense", "cancelled"));
  assert.ok(!svc.canTransition(undefined, undefined, undefined));
});

console.log("Service requests, what each side sees:");

const row = {
  id: 5, tier: "removals", status: "confirmed", pickup_address: "A", destination_address: "B", requested_at: "2026-10-27T10:00:00Z",
  passenger_count: 1, option: "two_bed", crew_size: 4, details: "piano", quoted_fare_naira: 90000, created_at: "x",
  contact_phone: "+2348012345678", rider_name: "Ada Obi Eze", user_id: 9,
};

test("rider view carries no phone numbers or other people's data", () => {
  const v = svc.toRiderView(row);
  assert.ok(!JSON.stringify(v).includes("+234"));
  assert.ok(!("contactPhone" in v) && !("contact_phone" in v) && !("rider_name" in v));
  assert.strictEqual(v.quotedFareNaira, 90000);
});

test("driver view has the rider's first name only and no phone", () => {
  const v = svc.toDriverView(row);
  assert.strictEqual(v.riderFirstName, "Ada");
  assert.ok(!JSON.stringify(v).includes("+234"));
  assert.ok(!JSON.stringify(v).includes("Eze"));
  assert.strictEqual(v.fareNaira, 90000);
});

test("driver view survives a missing rider name", () => {
  assert.strictEqual(svc.toDriverView({ ...row, rider_name: null }).riderFirstName, "Rider");
});

console.log(`\n${passed} passed`);
