const test = require("node:test");
const assert = require("node:assert/strict");
const { pickFlight, mapStatus } = require("./flightAware");

test("maps FlightAware flags to the statuses the console knows", () => {
  assert.equal(mapStatus({ cancelled: true }), "cancelled");
  assert.equal(mapStatus({ diverted: true }), "diverted");
  assert.equal(mapStatus({ actual_in: "2026-10-25T03:00:00Z" }), "landed");
  assert.equal(mapStatus({ actual_off: "2026-10-25T01:00:00Z" }), "active");
  assert.equal(mapStatus({}), "scheduled");
});

test("picks the flight in the air, then the nearest one, skipping cancelled", () => {
  const now = Date.now();
  const h = (n) => new Date(now + n * 3600 * 1000).toISOString();
  const airborne = { id: "air", actual_off: h(-2), scheduled_in: h(2) };
  assert.equal(pickFlight([{ id: "later", scheduled_in: h(30) }, airborne]).id, "air");
  const near = { id: "near", scheduled_in: h(3) };
  const cancelledNear = { id: "x", cancelled: true, scheduled_in: h(1) };
  assert.equal(pickFlight([cancelledNear, { id: "far", scheduled_in: h(40) }, near]).id, "near");
  assert.equal(pickFlight([]), null);
});
