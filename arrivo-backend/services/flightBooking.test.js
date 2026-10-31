const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { parseFlightBooking, saveFlightDetails } = require("./flightBooking");
const vault = require("./pnrVault");

const now = new Date("2026-11-01T08:00:00Z");
const parse = (body, bookingType = "one_way") => parseFlightBooking(body, { bookingType, now });

test("a pickup needs a flight number, and it is stored cleaned", () => {
  assert.equal(parse({}).error.code, "flight_empty");
  const r = parse({ flightNumber: "ba 075", flightDate: "2026-11-02", passengerSurname: " Obi ", pnr: "ab12cd" });
  assert.deepEqual([r.details.flightNumber, r.details.flightDate, r.details.surname, r.details.pnr, r.details.pnrMasked], ["BA75", "2026-11-02", "Obi", "AB12CD", "••••CD"]);
});

test("a drop-off may leave the flight out", () => {
  assert.equal(parse({}, "dropoff").details.flightNumber, null);
});

test("a new client that types a booking code into the flight box is told what to do", () => {
  const r = parse({ flightNumber: "XQ7K9P", flightDate: "2026-11-02" });
  assert.equal(r.error.code, "flight_pnr_like");
  assert.match(r.error.message, /booking code/);
});

test("an older client doing the same still books, with the code kept as a PNR and the booking flagged", () => {
  const r = parse({ flightNumber: "XQ7K9P" });
  assert.equal(r.details.legacyPnrOnly, true);
  assert.equal(r.details.flightNumber, null);
  assert.equal(r.details.pnr, "XQ7K9P");
});

test("bad dates, surnames and codes are refused with plain messages", () => {
  assert.equal(parse({ flightNumber: "BA75", flightDate: "2026-10-01" }).error.code, "flight_date_past");
  assert.equal(parse({ flightNumber: "BA75", flightDate: "tomorrow" }).error.code, "flight_date_format");
  assert.equal(parse({ flightNumber: "BA75", passengerSurname: "123" }).error.code, "surname_invalid");
  assert.equal(parse({ flightNumber: "BA75", pnr: "no" }).error.code, "pnr_invalid");
});

function fakeDb() { const calls = []; return { calls, query: async (sql, params) => { calls.push(params); return { rows: [] }; } }; }

test("saving seals the PNR and never writes it in the clear", async () => {
  process.env.FLIGHT_PNR_KEY = crypto.randomBytes(32).toString("base64");
  const db = fakeDb();
  await saveFlightDetails(db, 41, parse({ flightNumber: "BA75", flightDate: "2026-11-02", pnr: "AB12CD" }).details, { state: "tracked", reason: "provider" });
  const [id, date, surname, sealed, masked, state, reason] = db.calls[0];
  assert.deepEqual([id, date, surname, masked, state, reason], [41, "2026-11-02", null, "••••CD", "tracked", "provider"]);
  assert.equal(vault.open(sealed, 41), "AB12CD");
  assert.ok(!JSON.stringify(db.calls).includes("AB12CD"));
});

test("with no vault key the booking still saves, without a PNR and without a masked hint", async () => {
  delete process.env.FLIGHT_PNR_KEY;
  const db = fakeDb();
  await saveFlightDetails(db, 42, parse({ flightNumber: "BA75", pnr: "AB12CD" }).details);
  assert.deepEqual([db.calls[0][3], db.calls[0][4]], [null, null]);
});

test("a legacy booking-code-only ride is marked pnr_only for Ops", async () => {
  process.env.FLIGHT_PNR_KEY = crypto.randomBytes(32).toString("base64");
  const db = fakeDb();
  await saveFlightDetails(db, 43, parse({ flightNumber: "XQ7K9P" }).details);
  assert.deepEqual([db.calls[0][5], db.calls[0][6]], ["pnr_only", "pnr_in_flight_box"]);
});
