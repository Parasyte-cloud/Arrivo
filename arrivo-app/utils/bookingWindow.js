// The booking window rules from the corrections brief.
//
//   48h or more   standard booking, everything works as normal
//   12h to 48h    still open. The brief marks this "gap to resolve" and Ops
//                 hasn't ruled on it yet, so it's deliberately one constant
//                 below rather than logic scattered across two screens.
//   under 12h     standard booking is blocked and the rider goes to On the Go
//                 or WhatsApp, never a bare error.
//
// If Ops decides the 12 to 48 band should also be blocked, change
// ON_THE_GO_ONLY_HOURS to 48 and everything follows.

export const STANDARD_MIN_HOURS = 48;
export const ON_THE_GO_ONLY_HOURS = 12;

// What the rules are right now. Starts as the constants above and can be
// replaced by GET /api/config/booking (see services/bookingConfig.js), so Ops
// can change the notice period without an app release. If the config never
// arrives, the constants above apply. They have to match the backend's own,
// see the parity test in arrivo-backend/services/bookingWindow.test.js.
let rules = {
  standardMinHours: STANDARD_MIN_HOURS,
  onTheGoOnlyHours: ON_THE_GO_ONLY_HOURS,
  maxAdvanceDays: null, // null: no limit has been decided
};

export function getBookingRules() {
  return rules;
}

function wholeNumber(value, min, max) {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : null;
}

// Takes the config response. Each field is checked on its own, a bad one is
// ignored, and the result is never self-contradictory (the standard notice
// cannot be shorter than the On the Go cutoff).
export function setBookingRulesFromConfig(raw) {
  if (!raw || typeof raw !== "object") return;
  const onTheGo = wholeNumber(raw.minHours, 1, 168);
  const standard = wholeNumber(raw.standardMinHours, 1, 720);
  const next = {
    onTheGoOnlyHours: onTheGo != null ? onTheGo : rules.onTheGoOnlyHours,
    standardMinHours: standard != null ? standard : rules.standardMinHours,
    maxAdvanceDays: raw.maxAdvanceDays === null ? null : wholeNumber(raw.maxAdvanceDays, 1, 730) ?? rules.maxAdvanceDays,
  };
  if (next.standardMinHours < next.onTheGoOnlyHours) return;
  rules = next;
}

export function resetBookingRules() {
  rules = { standardMinHours: STANDARD_MIN_HOURS, onTheGoOnlyHours: ON_THE_GO_ONLY_HOURS, maxAdvanceDays: null };
}

export function hoursUntil(when, now = Date.now()) {
  // Check for nothing BEFORE building a Date. new Date(null) is epoch 0, which
  // is a perfectly finite number, so without this a booking with no scheduled
  // time reads as decades overdue and gets blocked. That's every airport
  // pickup, since those are timed off the flight and never carry a date here.
  if (when == null || when === "") return null;
  const time = when instanceof Date ? when.getTime() : new Date(when).getTime();
  if (!Number.isFinite(time)) return null;
  return (time - now) / (1000 * 60 * 60);
}

// "standard" | "gap" | "on_the_go_only"
export function bookingWindow(when, now = Date.now()) {
  const hours = hoursUntil(when, now);
  // No date to judge, so don't stand in the way. Airport pickups are timed off
  // the flight rather than a date the rider picks, see the note in the PR.
  if (hours == null) return "standard";
  if (hours >= rules.standardMinHours) return "standard";
  if (hours >= rules.onTheGoOnlyHours) return "gap";
  return "on_the_go_only";
}

export function isStandardBookingBlocked(when, now = Date.now()) {
  return bookingWindow(when, now) === "on_the_go_only";
}

// Earliest moment a standard booking is allowed, for the date picker's
// minimumDate so the rider can't pick their way into a blocked slot.
export function earliestStandardBooking(now = Date.now()) {
  return new Date(now + rules.onTheGoOnlyHours * 60 * 60 * 1000);
}
