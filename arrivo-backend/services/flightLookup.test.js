const test = require("node:test");
const assert = require("node:assert/strict");
const { lookupFlight } = require("./flightLookup");

const now = new Date("2026-11-01T08:00:00Z");
const flight = (day = "2026-11-01") => ({ status: "scheduled", arrival: { scheduled: `${day}T14:00:00Z`, estimated: `${day}T14:00:00Z` } });
const base = { flightNumber: "ba 075", date: "2026-11-01", now };

test("asks the provider for the cleaned flight number and the rider's date", async () => {
  let seen;
  const r = await lookupFlight({ ...base, _providers: [["fake", async (n, a, o) => { seen = [n, a, o]; return flight(); }]] });
  assert.deepEqual(seen, ["BA75", "LOS", { date: "2026-11-01" }]);
  assert.equal(r.state, "tracked");
  assert.equal(r.flight.provider, "fake");
});

test("falls through to the second provider when the first has nothing or fails", async () => {
  const r = await lookupFlight({ ...base, _providers: [["a", async () => { throw new Error("quota"); }], ["b", async () => flight()]] });
  assert.equal(r.state, "tracked");
  assert.equal(r.flight.provider, "b");
});

test("every provider failing is unknown with a provider reason, not a thrown error", async () => {
  const r = await lookupFlight({ ...base, _providers: [["a", async () => { throw new Error("quota"); }]] });
  assert.equal(r.state, "unknown");
  assert.equal(r.reason, "provider_error");
});

test("no provider configured is unknown, never a made-up status", async () => {
  const r = await lookupFlight({ ...base, _providers: [] });
  assert.deepEqual([r.state, r.reason, r.flight], ["unknown", "no_provider", null]);
});

test("another day's instance of the same flight is ignored", async () => {
  const r = await lookupFlight({ ...base, _providers: [["a", async () => flight("2026-10-31")]] });
  assert.equal(r.state, "unknown");
  assert.equal(r.reason, "not_found");
});

test("a booking code typed as the flight is never sent to a provider", async () => {
  let called = false;
  const r = await lookupFlight({ flightNumber: "XQ7K9P", date: "2026-11-01", now, _providers: [["a", async () => { called = true; return flight(); }]] });
  assert.equal(called, false);
  assert.equal(r.reason, "pnr_suspected");
});

test("a six character value that is also a legal flight is looked up, then flagged if not found", async () => {
  const r = await lookupFlight({ flightNumber: "AB1234", date: "2026-11-01", now, _providers: [["a", async () => null]] });
  assert.equal(r.reason, "pnr_suspected");
});

test("a departing flight is filtered by where it leaves, not where it lands", async () => {
  let seen;
  const dep = { status: "scheduled", departure: { scheduled: "2026-11-01T20:00:00Z" }, arrival: { scheduled: "2026-11-02T04:00:00Z" } };
  const r = await lookupFlight({ ...base, direction: "departure", _providers: [["a", async (n, a, o) => { seen = [n, a, o]; return dep; }]] });
  assert.deepEqual(seen, ["BA75", null, { date: "2026-11-01", depIata: "LOS" }]);
  assert.equal(r.state, "tracked");
});

test("a flight more than two days out never calls a provider", async () => {
  const boom = [["x", async () => { throw new Error("provider must not be called"); }]];
  const now = new Date("2026-11-01T08:00:00Z");
  const r = await lookupFlight({ flightNumber: "BA75", date: "2026-11-10", now, _providers: boom });
  assert.deepEqual([r.state, r.reason], ["not_yet", "beyond_window"]);
});
