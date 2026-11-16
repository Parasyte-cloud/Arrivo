// Turns what a rider typed into something a flight provider can use, and says plainly when it
// cannot. Pure functions, no network, no database: everything here is pinned by tests.
//
// Why this exists: flight status services are keyed by flight number and date. A PNR is an airline
// reservation record and no public status service can look one up, so a PNR typed into the
// "flight number" box used to fail every lookup silently (no ETA, no reminders, nothing in Ops).

const LAGOS_OFFSET = "+01:00"; // Africa/Lagos has no daylight saving.

// 2 character IATA airline code (at least one letter, so "3K" and "W3" pass but "12" does not) or
// 3 letter ICAO code, then 1 to 4 digits, then an optional operational suffix letter.
const IATA = /^([A-Z][A-Z0-9]|[A-Z0-9][A-Z])(\d{1,4})([A-Z])?$/;
const ICAO = /^([A-Z]{3})(\d{1,4})([A-Z])?$/;
const PNR = /^[A-Z0-9]{5,8}$/;

function squash(raw) {
  return String(raw ?? "").normalize("NFKC").toUpperCase().replace(/[\s\-._/]+/g, "");
}

// "ba 075" -> { ok: true, ident: "BA75" }. Leading zeros are dropped because providers index the
// flight as BA75, not BA075. A value that is not a flight number comes back with a reason the
// app can show: "pnr_like" for a booking code, "format" for anything else.
function normalizeFlightNumber(raw) {
  const s = squash(raw);
  if (!s) return { ok: false, reason: "empty" };
  const m = s.match(IATA) || s.match(ICAO);
  if (m) {
    const number = String(Number(m[2]));
    if (number === "0") return { ok: false, reason: "format" };
    return { ok: true, ident: `${m[1]}${number}${m[3] || ""}`, airline: m[1], number };
  }
  return { ok: false, reason: PNR.test(s) && /\d/.test(s) && /[A-Z]/.test(s) ? "pnr_like" : "format" };
}

// A 6 character code such as "AB1234" is both a legal flight number and a legal PNR. This lets the
// caller decide to treat it as a flight and still flag it if the lookup finds nothing.
function couldAlsoBePnr(raw) {
  const s = squash(raw);
  // Record locators are six characters. A five character value such as BA075 is a flight.
  return s.length === 6 && PNR.test(s) && /\d/.test(s) && /[A-Z]/.test(s);
}

function lagosToday(now = new Date()) {
  return new Date(now.getTime() + 60 * 60 * 1000).toISOString().slice(0, 10);
}

// YYYY-MM-DD, a real calendar day, not before today in Lagos, at most a year ahead.
function normalizeFlightDate(raw, now = new Date()) {
  const s = String(raw ?? "").trim();
  if (!s) return { ok: false, reason: "empty" };
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return { ok: false, reason: "format" };
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return { ok: false, reason: "format" };
  const today = lagosToday(now);
  if (s < today) return { ok: false, reason: "past" };
  const limit = new Date(Date.parse(`${today}T00:00:00Z`) + 366 * 86400000).toISOString().slice(0, 10);
  if (s > limit) return { ok: false, reason: "too_far" };
  return { ok: true, date: s };
}

function normalizeSurname(raw) {
  const s = String(raw ?? "").normalize("NFKC").trim().replace(/\s+/g, " ");
  if (!s) return { ok: false, reason: "empty" };
  if (s.length > 60 || !/^[\p{L}][\p{L} '’-]*$/u.test(s)) return { ok: false, reason: "format" };
  return { ok: true, surname: s };
}

function normalizePnr(raw) {
  const s = squash(raw);
  if (!s) return { ok: false, reason: "empty" };
  if (!PNR.test(s)) return { ok: false, reason: "format" };
  return { ok: true, pnr: s, masked: maskPnr(s) };
}

// Shows enough for a person on the phone to confirm ("ends in CD") and nothing more.
function maskPnr(pnr) {
  const s = String(pnr || "");
  return s ? `${"•".repeat(Math.max(0, s.length - 2))}${s.slice(-2)}` : null;
}

// The window in which a flight on this Lagos calendar day can land: from 3 hours before midnight
// (a flight that left early and is landing at 00:30) to 6 hours after the day ends.
function flightWindow(dateStr) {
  const start = Date.parse(`${dateStr}T00:00:00${LAGOS_OFFSET}`) - 3 * 3600000;
  const end = Date.parse(`${dateStr}T23:59:59${LAGOS_OFFSET}`) + 6 * 3600000;
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
}

function lagosDay(iso) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t + 3600000).toISOString().slice(0, 10) : null;
}

// Providers only see about two days ahead. A flight further out is "not yet", which is a normal
// answer and not an error, so nobody chases a booking that simply cannot be tracked yet.
const TRACKABLE_HOURS_AHEAD = 48;

// The one place that decides what Ops and the rider are told. Never invents a status: when there
// is nothing to go on the state is "unknown" and the reason says why.
function describeTracking({ ident, date, flight, providerError, couldBePnr = false, direction = "arrival", now = new Date() }) {
  if (!ident) return { state: "no_flight", label: "No flight number", reason: "none_given" };
  if (providerError) return { state: "unknown", label: "Flight status unavailable", reason: "provider_error" };
  if (!flight) {
    if (date) {
      const hoursAhead = (Date.parse(`${date}T00:00:00${LAGOS_OFFSET}`) - now.getTime()) / 3600000;
      if (hoursAhead > TRACKABLE_HOURS_AHEAD) return { state: "not_yet", label: "Too early to track", reason: "beyond_window" };
    }
    if (couldBePnr) return { state: "unknown", label: "Not found. Is this a booking code?", reason: "pnr_suspected" };
    return { state: "unknown", label: "Flight not found", reason: "not_found" };
  }
  const when = direction === "departure" ? flight.departure?.scheduled : flight.arrival?.estimated || flight.arrival?.scheduled;
  if (date && when && lagosDay(when) !== date) return { state: "unknown", label: "Flight found on a different day", reason: "date_mismatch" };
  const status = String(flight.status || "").toLowerCase();
  if (status === "cancelled") return { state: "cancelled", label: "Flight cancelled", reason: "provider" };
  if (status === "diverted") return { state: "diverted", label: "Flight diverted", reason: "provider" };
  if (status === "landed") return { state: "landed", label: "Landed", reason: "provider" };
  if (!when) return { state: "unknown", label: "No arrival time yet", reason: "no_eta" };
  const delayMin = direction === "departure" ? 0 : flight.arrival?.estimated && flight.arrival?.scheduled
    ? Math.round((Date.parse(flight.arrival.estimated) - Date.parse(flight.arrival.scheduled)) / 60000) : 0;
  return { state: delayMin >= 15 ? "delayed" : "tracked", label: delayMin >= 15 ? `Delayed ${delayMin} min` : "Tracked", reason: "provider", delayMin };
}

module.exports = {
  normalizeFlightNumber, couldAlsoBePnr, normalizeFlightDate, normalizeSurname, normalizePnr,
  maskPnr, flightWindow, lagosDay, lagosToday, describeTracking, TRACKABLE_HOURS_AHEAD,
};
