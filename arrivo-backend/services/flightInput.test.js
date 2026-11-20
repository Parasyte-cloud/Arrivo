const test = require("node:test");
const assert = require("node:assert/strict");
const f = require("./flightInput");

test("flight numbers are cleaned the way providers index them", () => {
  for (const [raw, ident] of [["ba075", "BA75"], ["BA 75", "BA75"], ["ba-0075", "BA75"], ["W3 123", "W3123"], ["3K 5", "3K5"], ["BAW75", "BAW75"], ["WB 123A", "WB123A"], ["  ET 905 ", "ET905"]]) {
    assert.deepEqual(f.normalizeFlightNumber(raw).ident, ident, raw);
  }
});

test("a booking code in the flight box is named as one, not looked up", () => {
  assert.equal(f.normalizeFlightNumber("XQ7K9P").reason, "pnr_like");
  assert.equal(f.normalizeFlightNumber("ABCDEF").reason, "format");
  assert.equal(f.normalizeFlightNumber("123456").reason, "format");
  assert.equal(f.normalizeFlightNumber("").reason, "empty");
  assert.equal(f.normalizeFlightNumber("BA0").ok, false);
});

test("six characters that are both a flight and a code are treated as a flight but flagged", () => {
  assert.equal(f.normalizeFlightNumber("AB1234").ok, true);
  assert.equal(f.couldAlsoBePnr("AB1234"), true);
  assert.equal(f.couldAlsoBePnr("BA75"), false);
  assert.equal(f.couldAlsoBePnr("BA 075"), false, "five characters is a flight, not a record locator");
});

test("flight dates are real days, in Lagos time, from today to a year out", () => {
  const now = new Date("2026-10-31T23:30:00Z"); // already 1 Nov in Lagos
  assert.equal(f.lagosToday(now), "2026-11-01");
  assert.equal(f.normalizeFlightDate("2026-10-31", now).reason, "past");
  assert.equal(f.normalizeFlightDate("2026-11-01", now).ok, true);
  assert.equal(f.normalizeFlightDate("2026-02-30", now).reason, "format");
  assert.equal(f.normalizeFlightDate("01/11/2026", now).reason, "format");
  assert.equal(f.normalizeFlightDate("2028-01-01", now).reason, "too_far");
});

test("surnames allow real names and refuse junk", () => {
  assert.equal(f.normalizeSurname("  Obi-Eze ").surname, "Obi-Eze");
  assert.equal(f.normalizeSurname("O'Brien").ok, true);
  assert.equal(f.normalizeSurname("Adébáyò").ok, true);
  assert.equal(f.normalizeSurname("12345").ok, false);
  assert.equal(f.normalizeSurname("<script>").ok, false);
});

test("a PNR is cleaned, validated and masked to its last two characters", () => {
  const r = f.normalizePnr("ab 12-cd");
  assert.equal(r.pnr, "AB12CD");
  assert.equal(r.masked, "••••CD");
  assert.equal(f.normalizePnr("abc").ok, false);
  assert.equal(f.normalizePnr("ABCDEFGHIJ").ok, false);
});

test("the flight window covers a Lagos day plus early and late arrivals", () => {
  const w = f.flightWindow("2026-11-02");
  assert.equal(w.start, "2026-11-01T20:00:00.000Z");
  assert.equal(w.end, "2026-11-03T04:59:59.000Z");
});

const now = new Date("2026-11-01T08:00:00Z");
const arr = (scheduled, estimated) => ({ status: "scheduled", arrival: { scheduled, estimated } });

test("tracking never invents a status", () => {
  assert.equal(f.describeTracking({ ident: null }).state, "no_flight");
  assert.equal(f.describeTracking({ ident: "BA75", date: "2026-11-01", flight: null, now }).reason, "not_found");
  assert.equal(f.describeTracking({ ident: "AB1234", date: "2026-11-01", flight: null, couldBePnr: true, now }).reason, "pnr_suspected");
  assert.equal(f.describeTracking({ ident: "BA75", date: "2026-11-01", providerError: true, now }).reason, "provider_error");
});

test("a flight too far ahead is too early to track, not a failure", () => {
  assert.equal(f.describeTracking({ ident: "BA75", date: "2026-11-20", flight: null, now }).state, "not_yet");
  assert.equal(f.describeTracking({ ident: "BA75", date: "2026-11-02", flight: null, now }).state, "unknown");
});

test("tracked, delayed, cancelled, diverted and landed come from the provider only", () => {
  assert.equal(f.describeTracking({ ident: "BA75", date: "2026-11-01", flight: arr("2026-11-01T14:00:00Z", "2026-11-01T14:05:00Z"), now }).state, "tracked");
  const d = f.describeTracking({ ident: "BA75", date: "2026-11-01", flight: arr("2026-11-01T14:00:00Z", "2026-11-01T15:10:00Z"), now });
  assert.equal(d.state, "delayed");
  assert.equal(d.delayMin, 70);
  assert.equal(f.describeTracking({ ident: "BA75", flight: { status: "cancelled", arrival: { scheduled: "2026-11-01T14:00:00Z" } }, now }).state, "cancelled");
  assert.equal(f.describeTracking({ ident: "BA75", flight: { status: "diverted", arrival: {} }, now }).state, "diverted");
  assert.equal(f.describeTracking({ ident: "BA75", flight: { status: "landed", arrival: { scheduled: "2026-11-01T14:00:00Z" } }, now }).state, "landed");
});

test("a flight found on another day is not trusted for this booking", () => {
  const r = f.describeTracking({ ident: "BA75", date: "2026-11-02", flight: arr("2026-11-01T14:00:00Z"), now });
  assert.equal(r.reason, "date_mismatch");
});
