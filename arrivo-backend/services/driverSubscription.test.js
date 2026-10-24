const test = require("node:test");
const assert = require("node:assert/strict");
const s = require("./driverSubscription");

const at = (iso) => new Date(iso);

test("price is 2,000 naira", () => assert.equal(s.DAILY_PRICE_NAIRA, 2000));

test("lagosDay rolls over at 23:00 UTC, which is midnight in Lagos", () => {
  assert.equal(s.lagosDay(at("2026-10-24T22:59:59Z")), "2026-10-24");
  assert.equal(s.lagosDay(at("2026-10-24T23:00:00Z")), "2026-10-25");
  assert.equal(s.lagosDay(at("2026-12-31T23:30:00Z")), "2027-01-01");
});

test("endOfLagosDay is the next 00:00 Lagos", () => {
  assert.equal(s.endOfLagosDay(at("2026-10-24T10:00:00Z")).toISOString(), "2026-10-24T23:00:00.000Z");
  assert.equal(s.endOfLagosDay(at("2026-10-24T22:59:59Z")).toISOString(), "2026-10-24T23:00:00.000Z");
  assert.equal(s.endOfLagosDay(at("2026-10-24T23:00:00Z")).toISOString(), "2026-10-25T23:00:00.000Z");
});

test("a bad time throws instead of guessing", () => {
  assert.throws(() => s.lagosDay("nope"));
  assert.throws(() => s.endOfLagosDay(NaN));
});

test("subscribed only when a paid day is today in Lagos", () => {
  const now = at("2026-10-24T12:00:00Z");
  assert.equal(s.isSubscribedOn(["2026-10-24"], now), true);
  assert.equal(s.isSubscribedOn(["2026-10-23"], now), false);
  assert.equal(s.isSubscribedOn([new Date("2026-10-24T00:00:00Z")], now), true);
  assert.equal(s.isSubscribedOn([], now), false);
  assert.equal(s.isSubscribedOn(null, now), false);
});

test("subscription ends at Lagos midnight, not UTC midnight", () => {
  const paid = ["2026-10-24"];
  assert.equal(s.isSubscribedOn(paid, at("2026-10-24T22:59:59Z")), true);
  assert.equal(s.isSubscribedOn(paid, at("2026-10-24T23:00:00Z")), false);
});

test("status carries the end time only while active", () => {
  const on = s.subscriptionStatus(["2026-10-24"], at("2026-10-24T10:00:00Z"));
  assert.equal(on.active, true);
  assert.equal(on.endsAt, "2026-10-24T23:00:00.000Z");
  assert.equal(on.priceNaira, 2000);
  const off = s.subscriptionStatus([], at("2026-10-24T10:00:00Z"));
  assert.equal(off.active, false);
  assert.equal(off.endsAt, null);
});

test("addMonths clamps to month end and crosses years", () => {
  assert.equal(s.addMonths("2026-01-31", 1), "2026-02-28");
  assert.equal(s.addMonths("2028-01-31", 1), "2028-02-29");
  assert.equal(s.addMonths("2026-11-15", 3), "2027-02-15");
  assert.equal(s.addMonths("2026-12-31", 3), "2027-03-31");
  assert.throws(() => s.addMonths("2026-13-01", 1));
});

test("inspection is due three months after the last one", () => {
  assert.equal(s.inspectionDueOn("2026-07-24"), "2026-10-24");
});

test("no inspection on record is red", () => {
  for (const v of [null, undefined, "", "garbage"]) {
    const r = s.inspectionStatus(v, at("2026-10-24T10:00:00Z"));
    assert.equal(r.state, "not_recorded");
    assert.equal(r.severity, "red");
  }
});

test("quiet until 7 days before due, then red", () => {
  const last = "2026-07-24"; // due 2026-10-24
  const state = (iso) => s.inspectionStatus(last, at(iso));
  assert.equal(state("2026-10-16T10:00:00Z").state, "ok"); // 8 days left
  assert.equal(state("2026-10-16T10:00:00Z").severity, "none");
  const d7 = state("2026-10-17T10:00:00Z");
  assert.equal(d7.state, "due_soon");
  assert.equal(d7.daysLeft, 7);
  assert.equal(d7.severity, "red");
  assert.equal(state("2026-10-23T10:00:00Z").daysLeft, 1);
  assert.match(state("2026-10-23T10:00:00Z").message, /1 day\./);
  assert.equal(state("2026-10-24T10:00:00Z").state, "due_today");
  const late = state("2026-10-26T10:00:00Z");
  assert.equal(late.state, "overdue");
  assert.equal(late.daysLeft, -2);
  assert.match(late.message, /2 days/);
});

test("the countdown follows the Lagos day, not UTC", () => {
  // 23:30 UTC on the 16th is already the 17th in Lagos: 7 days left.
  assert.equal(s.inspectionStatus("2026-07-24", at("2026-10-16T23:30:00Z")).state, "due_soon");
});

test("a Date from the database works as the last inspection day", () => {
  assert.equal(s.inspectionStatus(new Date("2026-07-24T00:00:00Z"), at("2026-10-24T10:00:00Z")).state, "due_today");
});
