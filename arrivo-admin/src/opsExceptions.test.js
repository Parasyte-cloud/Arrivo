// Run directly: node src/opsExceptions.test.js
import assert from "node:assert";
import { tripExceptions, upcomingAirport, span } from "./opsExceptions.js";

const NOW = Date.parse("2026-10-25T12:00:00Z");
const at = (min) => new Date(NOW + min * 60000).toISOString();
let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log(`ok  ${name}`); }

test("a booked pickup 30 min away with no driver is a warning", () => {
  const [e] = tripExceptions([{ id: 1, ride_status: "requested", scheduled_pickup_at: at(30), rider_name: "Ada" }], NOW);
  assert.equal(e.tone, "warning");
  assert.match(e.meta, /in 30 min/);
});

test("a booked pickup within 15 min with no driver is critical, overdue says so", () => {
  const [a, b] = tripExceptions([
    { id: 2, ride_status: "accepted", scheduled_pickup_at: at(10) },
    { id: 3, ride_status: "requested", scheduled_pickup_at: at(-20) },
  ], NOW);
  assert.equal(a.tone, "critical");
  assert.equal(b.tone, "critical");
  assert.match(b.meta, /20 min overdue/);
});

test("a pickup far in the future, or one with a driver, is not an exception", () => {
  assert.equal(tripExceptions([
    { id: 4, ride_status: "requested", scheduled_pickup_at: at(120) },
    { id: 5, ride_status: "accepted", scheduled_pickup_at: at(5), driver_name: "Tunde" },
  ], NOW).length, 0);
});

test("an on-demand ride waits 5 min before it counts, 15 min makes it critical", () => {
  const out = tripExceptions([
    { id: 6, ride_status: "requested", created_at: at(-3) },
    { id: 7, ride_status: "requested", created_at: at(-8) },
    { id: 8, ride_status: "requested", created_at: at(-20) },
  ], NOW);
  assert.deepEqual(out.map((e) => [e.key, e.tone]), [["waiting-7", "warning"], ["waiting-8", "critical"]]);
});

test("driver GPS silence only counts on a live trip that reported before", () => {
  const out = tripExceptions([
    { id: 9, ride_status: "in_progress", driver_name: "Tunde", location_updated_at: at(-6) },
    { id: 10, ride_status: "in_progress", driver_name: "Tunde", location_updated_at: at(-1) },
    { id: 11, ride_status: "in_progress", driver_name: "Tunde", location_updated_at: null },
  ], NOW);
  assert.deepEqual(out.map((e) => e.key), ["gps-9"]);
});

test("finished and cancelled rides never raise exceptions", () => {
  assert.equal(tripExceptions([
    { id: 12, ride_status: "completed", created_at: at(-90) },
    { id: 13, ride_status: "cancelled", created_at: at(-90) },
  ], NOW).length, 0);
});

test("airport pickups are sorted soonest first and capped to the look-ahead", () => {
  const out = upcomingAirport([
    { id: 1, flight_number: "BA75", ride_status: "requested", scheduled_pickup_at: at(90) },
    { id: 2, flight_number: "ET905", ride_status: "accepted", scheduled_pickup_at: at(20), driver_name: "Tunde" },
    { id: 3, flight_number: "KQ1", ride_status: "requested", scheduled_pickup_at: at(600) },
    { id: 4, ride_status: "requested", scheduled_pickup_at: at(10) },
  ], NOW);
  assert.deepEqual(out.map((x) => x.trip.id), [2, 1]);
});

test("span reads naturally", () => {
  assert.equal(span(45), "45 min");
  assert.equal(span(-125), "2 h 5 min");
});

console.log(`\n${passed} passed`);
