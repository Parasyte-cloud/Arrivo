// Tests for what a driver sees on each tier and how a service job is run. Run directly:
//   node tiers/jobs.test.js
//
// jobs.js is import-free, so it is evaluated without a bundler.

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "jobs.js"), "utf8");
assert.ok(!/^\s*import\s/m.test(src), "jobs.js has to stay import-free for this test to load it");
assert.ok(!src.includes(String.fromCharCode(0x2014)), "no em dash in jobs.js");
const J = new Function(
  src.replace(/^export const /gm, "const ").replace(/^export function /gm, "function ") +
    "\nreturn { TIER_LABELS, SERVICE_TIERS, tierOfRide, rideBadge, nextStep, jobStatusLabel, optionName, headcount, formatNaira, dueLabel, busyOnServiceJob, sortJobs };"
)();

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

console.log("Tier names:");

test("all six tiers are named exactly as the business names them", () => {
  assert.deepStrictEqual(Object.values(J.TIER_LABELS).sort(), ["ArrivoAir", "ArrivoBoat", "ArrivoChauffer", "ArrivoExpress", "ArrivoRemovals", "RideArrivo"]);
});

test("rides map to the right tier", () => {
  assert.strictEqual(J.tierOfRide({ booking_type: "one_way" }), "ride");
  assert.strictEqual(J.tierOfRide({ booking_type: "dropoff" }), "ride");
  assert.strictEqual(J.tierOfRide({ booking_type: "full_day" }), "chauffer");
  assert.strictEqual(J.tierOfRide({ booking_type: "multi_day" }), "chauffer");
  assert.strictEqual(J.tierOfRide({ booking_type: "one_way", service_mode: "instant" }), "express");
  assert.strictEqual(J.tierOfRide({ booking_type: "one_way", service_mode: "scheduled" }), "ride");
  assert.strictEqual(J.tierOfRide(null), "ride");
  assert.strictEqual(J.tierOfRide(undefined), "ride");
  assert.strictEqual(J.tierOfRide({}), "chauffer", "an unknown booking type is not an airport trip");
});

test("card badges read clearly", () => {
  assert.strictEqual(J.rideBadge({ booking_type: "one_way" }), "RideArrivo pickup");
  assert.strictEqual(J.rideBadge({ booking_type: "dropoff" }), "RideArrivo drop-off");
  assert.strictEqual(J.rideBadge({ booking_type: "full_day" }), "ArrivoChauffer");
  assert.strictEqual(J.rideBadge({ service_mode: "instant" }), "ArrivoExpress");
  assert.strictEqual(J.rideBadge(null), "RideArrivo pickup");
});

console.log("Running a service job:");

test("a ready job offers Start, a started one offers Complete, nothing else offers anything", () => {
  for (const tier of ["air", "boat", "removals"]) {
    const start = J.nextStep({ tier, status: "confirmed" });
    const fin = J.nextStep({ tier, status: "in_progress" });
    assert.strictEqual(start.to, "in_progress");
    assert.strictEqual(fin.to, "completed");
    assert.notStrictEqual(start.label, fin.label);
    assert.ok(J.nextStep({ tier, status: "completed" }) === null);
    assert.ok(J.nextStep({ tier, status: "cancelled" }) === null);
    assert.ok(J.nextStep({ tier, status: "pending" }) === null, "an unconfirmed request is not a job");
  }
  assert.strictEqual(J.nextStep(null), null);
  assert.strictEqual(J.nextStep({ tier: "express", status: "confirmed" }), null);
});

test("buttons use the words of the trade", () => {
  assert.strictEqual(J.nextStep({ tier: "air", status: "confirmed" }).label, "Start flight");
  assert.strictEqual(J.nextStep({ tier: "boat", status: "in_progress" }).label, "Complete trip");
  assert.strictEqual(J.nextStep({ tier: "removals", status: "confirmed" }).label, "Start move");
});

test("the steps are exactly the ones the server allows a driver", () => {
  // Server rule: a driver can only go confirmed -> in_progress -> completed.
  assert.strictEqual(J.nextStep({ tier: "air", status: "confirmed" }).to, "in_progress");
  assert.strictEqual(J.nextStep({ tier: "air", status: "in_progress" }).to, "completed");
});

test("status labels", () => {
  assert.strictEqual(J.jobStatusLabel("confirmed"), "READY");
  assert.strictEqual(J.jobStatusLabel("in_progress"), "UNDER WAY");
  assert.strictEqual(J.jobStatusLabel("completed"), "DONE");
  assert.strictEqual(J.jobStatusLabel("cancelled"), "CANCELLED");
  assert.strictEqual(J.jobStatusLabel(undefined), "");
});

console.log("Reading a job:");

test("headcount reads naturally for people and crews", () => {
  assert.strictEqual(J.headcount({ tier: "air", passengerCount: 1 }), "1 passenger");
  assert.strictEqual(J.headcount({ tier: "boat", passengerCount: 8 }), "8 passengers");
  assert.strictEqual(J.headcount({ tier: "removals", crewSize: 4, passengerCount: 1 }), "4 movers");
  assert.strictEqual(J.headcount({ tier: "removals" }), "");
  assert.strictEqual(J.headcount({ tier: "air", passengerCount: 0 }), "");
  assert.strictEqual(J.headcount({ tier: "air" }), "");
  assert.strictEqual(J.headcount(null), "");
});

test("option names and money", () => {
  assert.strictEqual(J.optionName("air", "private_jet"), "Private jet");
  assert.strictEqual(J.optionName("removals", "three_plus_bed"), "3+ bedroom");
  assert.strictEqual(J.optionName("boat", "weird"), "weird");
  assert.strictEqual(J.formatNaira(120000), "₦120,000");
  assert.strictEqual(J.formatNaira(null), "", "no fare is blank, never zero");
  assert.strictEqual(J.formatNaira("x"), "");
});

test("due time is Lagos time in any phone zone", () => {
  // 11:30 UTC is 12:30 in Lagos.
  assert.strictEqual(J.dueLabel("2026-10-27T11:30:00Z"), "Tue 27 Oct, 12:30");
  // Late evening UTC rolls into the next Lagos day.
  assert.strictEqual(J.dueLabel("2026-10-27T23:30:00Z"), "Wed 28 Oct, 00:30");
  assert.strictEqual(J.dueLabel(null), "");
  assert.strictEqual(J.dueLabel("nonsense"), "");
});

console.log("Pausing and ordering:");

test("a started service job pauses new ride offers, a ready one does not", () => {
  assert.strictEqual(J.busyOnServiceJob([{ status: "in_progress" }]), true);
  assert.strictEqual(J.busyOnServiceJob([{ status: "confirmed" }, { status: "in_progress" }]), true);
  assert.strictEqual(J.busyOnServiceJob([{ status: "confirmed" }]), false);
  assert.strictEqual(J.busyOnServiceJob([]), false);
  assert.strictEqual(J.busyOnServiceJob(undefined), false);
  assert.strictEqual(J.busyOnServiceJob([null]), false);
});

test("jobs sort: under way first, then soonest due, without changing the input", () => {
  const jobs = [
    { id: 1, status: "confirmed", requestedAt: "2026-10-30T10:00:00Z" },
    { id: 2, status: "confirmed", requestedAt: "2026-10-26T10:00:00Z" },
    { id: 3, status: "in_progress", requestedAt: "2026-10-31T10:00:00Z" },
    { id: 4, status: "confirmed", requestedAt: "2026-10-26T10:00:00Z" },
    { id: 5, status: "confirmed", requestedAt: "bad" },
  ];
  const copy = JSON.parse(JSON.stringify(jobs));
  assert.deepStrictEqual(J.sortJobs(jobs).map((j) => j.id), [3, 2, 4, 1, 5]);
  assert.deepStrictEqual(jobs, copy);
  assert.deepStrictEqual(J.sortJobs(undefined), []);
});

console.log(`\n${passed} passed`);
