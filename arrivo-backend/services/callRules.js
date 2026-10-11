// Pure rules for rider <-> driver in-app calls. No database, no network, so
// every edge case can be tested without either. routes/calls.js applies these
// to real rows.

const LIVE_RIDE_STATUSES = ["accepted", "in_progress"];
// Lost property, "I'm at the gate": a short grace window after the trip so the
// two people can still reach each other, and no longer.
const POST_TRIP_MINUTES = 30;
// How long a call may ring before it counts as missed. The app times out on
// its own; this is the server's own limit so a crashed app cannot leave a call
// "ringing" forever.
const RING_TIMEOUT_SECONDS = 45;
const RING_GRACE_SECONDS = 15;
// Abuse limits. Generous for real use (a driver stuck in traffic redialling)
// and tight for a person looking to harass.
const START_WINDOW_MINUTES = 10;
const MAX_STARTS_PER_RIDE_IN_WINDOW = 6;
const MAX_STARTS_PER_HOUR = 30;
// After this many calls in a row that did not connect, offer support.
const SUPPORT_AFTER_FAILURES = 2;
const FAILURE_STREAK_WINDOW_MINUTES = 20;

const TERMINAL = new Set(["ended", "missed", "declined", "cancelled", "failed"]);
const EVENTS = new Set(["connected", "ended", "missed", "declined", "cancelled", "failed"]);

// Can this ride be called about right now?
//   ride: { ride_status, driver_user_id, rider_id, updated_at }
function availability(ride, now = new Date()) {
  if (!ride) return { canCall: false, code: "ride_not_found", reason: "We couldn't find that ride." };
  if (!ride.driver_user_id) {
    return { canCall: false, code: "no_driver", reason: "You can call as soon as a driver has accepted this ride." };
  }
  if (LIVE_RIDE_STATUSES.includes(ride.ride_status)) return { canCall: true, code: "live", reason: null };
  if (ride.ride_status === "completed") {
    const finished = ride.updated_at ? new Date(ride.updated_at).getTime() : 0;
    const minutes = (now.getTime() - finished) / 60000;
    if (finished && minutes <= POST_TRIP_MINUTES) return { canCall: true, code: "post_trip", reason: null };
    return { canCall: false, code: "trip_over", reason: "This trip is over. For anything about it, contact support." };
  }
  if (ride.ride_status === "cancelled") {
    return { canCall: false, code: "cancelled", reason: "This ride was cancelled." };
  }
  return { canCall: false, code: "not_active", reason: "Calling opens once your driver has accepted the ride." };
}

// Who is the viewer on this ride? Returns "rider", "driver" or null.
function roleOnRide(ride, userId) {
  const id = Number(userId);
  if (Number(ride.rider_id) === id) return "rider";
  if (ride.driver_user_id != null && Number(ride.driver_user_id) === id) return "driver";
  return null;
}

// Move a session to its next state, or say why it cannot.
// Returns { ok, next, changed, code }.
//   ok       - the event is acceptable (including a harmless repeat)
//   changed  - the stored status should be updated
function transition(current, event, actorRole) {
  if (!EVENTS.has(event)) return { ok: false, changed: false, code: "unknown_event" };
  // Only the person who placed the call can cancel it before it is answered,
  // and only the person being called can decline it.
  if (event === "cancelled" && actorRole !== "caller") return { ok: false, changed: false, code: "not_allowed" };
  if (event === "declined" && actorRole !== "callee") return { ok: false, changed: false, code: "not_allowed" };

  if (TERMINAL.has(current)) {
    // Repeating the same terminal report (a retry after a lost response) is
    // fine and changes nothing. Contradicting it is not.
    if (current === event) return { ok: true, next: current, changed: false };
    // A hang-up reported after the call already ended or dropped is the other
    // side's matching "ended". Accept it quietly.
    if (event === "ended" && (current === "failed" || current === "ended")) return { ok: true, next: current, changed: false };
    return { ok: false, changed: false, code: "already_finished" };
  }

  if (current === "ringing") {
    if (event === "ended") return { ok: true, next: "cancelled", changed: true };
    return { ok: true, next: event, changed: event !== "ringing" };
  }
  if (current === "connected") {
    if (event === "connected") return { ok: true, next: "connected", changed: false };
    if (event === "ended" || event === "failed") return { ok: true, next: event, changed: true };
    return { ok: false, changed: false, code: "already_connected" };
  }
  return { ok: false, changed: false, code: "bad_state" };
}

// A call is "ringing" in the database until someone says otherwise. If it has
// been far longer than the ring window, treat it as missed.
function isStale(session, now = new Date()) {
  if (!session || session.status !== "ringing") return false;
  const age = (now.getTime() - new Date(session.created_at).getTime()) / 1000;
  return age > RING_TIMEOUT_SECONDS + RING_GRACE_SECONDS;
}

// Should the app put "Talk to support" in front of the person?
//   recent: this ride's sessions, newest first, each { status, created_at }
function supportSuggested(event, recent, now = new Date()) {
  if (event === "failed") return true;
  let streak = 0;
  const cutoff = now.getTime() - FAILURE_STREAK_WINDOW_MINUTES * 60000;
  for (const s of recent) {
    if (new Date(s.created_at).getTime() < cutoff) break;
    if (s.status === "connected" || s.status === "ended") break;
    if (s.status === "missed" || s.status === "failed") streak++;
  }
  return streak >= SUPPORT_AFTER_FAILURES;
}

function normaliseMedia(media) {
  return media === "video" ? "video" : "audio";
}

module.exports = {
  LIVE_RIDE_STATUSES,
  POST_TRIP_MINUTES,
  RING_TIMEOUT_SECONDS,
  RING_GRACE_SECONDS,
  START_WINDOW_MINUTES,
  MAX_STARTS_PER_RIDE_IN_WINDOW,
  MAX_STARTS_PER_HOUR,
  SUPPORT_AFTER_FAILURES,
  FAILURE_STREAK_WINDOW_MINUTES,
  TERMINAL,
  EVENTS,
  availability,
  roleOnRide,
  transition,
  isStale,
  supportSuggested,
  normaliseMedia,
};
