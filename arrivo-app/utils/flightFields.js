// Checks what the rider typed in the flight section of an airport pickup, before checkout, in the
// same terms the server uses (arrivo-backend/services/flightInput.js). Import-free so it runs
// under plain node:  node utils/flightFields.test.js
//
// A flight is tracked by flight number and date. A booking code (PNR) is a separate, optional box:
// no flight status service can look one up, and typing it in the flight box used to quietly break
// tracking for that booking.

const IATA = /^([A-Z][A-Z0-9]|[A-Z0-9][A-Z])(\d{1,4})([A-Z])?$/;
const ICAO = /^([A-Z]{3})(\d{1,4})([A-Z])?$/;

const squash = (v) => String(v ?? "").toUpperCase().replace(/[\s\-._/]+/g, "");

// Returns null when fine, otherwise one plain sentence to show under the field.
export function flightNumberProblem(value) {
  const s = squash(value);
  if (!s) return null;
  if (IATA.test(s) || ICAO.test(s)) return null;
  if (/^[A-Z0-9]{5,8}$/.test(s) && /\d/.test(s) && /[A-Z]/.test(s)) {
    return "That looks like a booking code. Put the flight number from your ticket here, for example BA75, and the booking code in the box below.";
  }
  return "Enter the airline code and digits, for example BA75 or ET 905.";
}

// today is YYYY-MM-DD in Lagos (pass lagosToday() from ./lagosTime).
export function flightDateProblem(value, today) {
  const s = String(value ?? "").trim();
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return "Enter the date as year-month-day, for example 2026-11-02.";
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return "That is not a real date.";
  if (s < today) return "That date has already passed.";
  return null;
}

export function pnrProblem(value) {
  const s = squash(value);
  if (!s) return null;
  return /^[A-Z0-9]{5,8}$/.test(s) ? null : "A booking code is 5 to 8 letters and numbers. You can leave it blank.";
}

export function addDays(day, n) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
}
