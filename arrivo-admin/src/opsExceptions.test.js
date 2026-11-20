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

test("an airport pickup booked for a later day is not flagged as waiting", () => {
  const trip = { id: 20, ride_status: "requested", booking_type: "one_way", flight_number: "BA75", flight_date: "2026-10-27", created_at: at(-30) };
  assert.equal(tripExceptions([trip], NOW).length, 0);
  assert.equal(tripExceptions([{ ...trip, flight_date: "2026-10-25" }], NOW).length, 1, "today's flight still alerts");
  assert.equal(tripExceptions([{ ...trip, flight_date: null }], NOW).length, 1, "older bookings without a date behave as before");
});

test("a cancelled or diverted flight is critical and ranks first", () => {
  const [e] = tripExceptions([{ id: 21, ride_status: "accepted", driver_name: "Tunde", flight_number: "ET905", flight_tracking_state: "cancelled", rider_name: "Ada" }], NOW);
  assert.equal(e.tone, "critical");
  assert.match(e.title, /ET905 cancelled/);
});

test("a booking code with no flight number asks for the flight", () => {
  const [e] = tripExceptions([{ id: 22, ride_status: "accepted", driver_name: "Tunde", flight_tracking_state: "pnr_only", rider_name: "Ada" }], NOW);
  assert.match(e.title, /booking code but no flight number/);
});

test("an untracked flight only raises an alert once it is close, and says why", () => {
  const base = { id: 23, ride_status: "accepted", driver_name: "Tunde", flight_number: "BA75", flight_tracking_state: "unknown", flight_tracking_reason: "pnr_suspected" };
  assert.equal(tripExceptions([{ ...base, flight_date: "2026-10-30" }], NOW).length, 0);
  const [e] = tripExceptions([{ ...base, flight_date: "2026-10-26" }], NOW);
  assert.match(e.meta, /may be a booking code/);
});

test("tracked, delayed, landed and too-early flights are not exceptions", () => {
  for (const state of ["tracked", "delayed", "landed", "not_yet", "no_flight"]) {
    assert.equal(tripExceptions([{ id: 24, ride_status: "accepted", driver_name: "T", flight_number: "BA75", flight_tracking_state: state }], NOW).length, 0, state);
  }
});


test("an arrival is ordered by the flight estimate, a drop-off by its pickup time", () => {
  const out = upcomingAirport([
    { id: 1, flight_number: "BA75", booking_type: "one_way", ride_status: "accepted", scheduled_pickup_at: at(30), flight_eta: at(200) },
    { id: 2, flight_number: "ET905", booking_type: "one_way", ride_status: "accepted", scheduled_pickup_at: at(90), flight_eta: at(45) },
    { id: 3, flight_number: "KQ", booking_type: "dropoff", ride_status: "accepted", scheduled_pickup_at: at(60), flight_eta: at(5) },
  ], NOW);
  assert.deepEqual(out.map((x) => x.trip.id).sort(), [2, 3].sort());
  assert.equal(out[0].trip.id, 2);
});

console.log(`\n${passed} passed`);
