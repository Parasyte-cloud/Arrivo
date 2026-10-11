// The call button's brain, with no React and no network so it can be tested.
// components/RideCallButton.js drives this and draws the result.
//
// The flow: tap -> check -> start -> ringing -> connected -> ended, or a clear
// failure with a way out. Whatever goes wrong, the person always lands on a
// screen with "Talk to support" on it. Nobody is left staring at a spinner.

export const PHASE = {
  IDLE: "idle",
  CHECKING: "checking",
  STARTING: "starting",
  RINGING: "ringing",
  CONNECTED: "connected",
  ENDED: "ended",
  FAILED: "failed",
};

export const SUPPORT_LINE = "Something went wrong with the call. Talk to our support team. We'll take care of you.";

// Failures that retrying cannot fix
const NO_RETRY = new Set(["no_driver", "not_active", "cancelled", "trip_over", "not_participant", "ride_not_found", "declined", "incoming_call", "already_in_call"]);

export function initialState() {
  return { phase: PHASE.IDLE, session: null, ringTimeoutSeconds: 45, failure: null, ticketId: null, supportBusy: false };
}

// One person, one finger: a second tap while anything is in flight does nothing.
export function canTap(state) {
  return state.phase === PHASE.IDLE || state.phase === PHASE.ENDED || state.phase === PHASE.FAILED;
}

export function reduce(state, action) {
  switch (action.type) {
    case "TAP":
      return canTap(state) ? { ...initialState(), phase: PHASE.CHECKING } : state;
    case "STARTING":
      return state.phase === PHASE.CHECKING ? { ...state, phase: PHASE.STARTING } : state;
    case "STARTED":
      if (state.phase !== PHASE.CHECKING && state.phase !== PHASE.STARTING) return state;
      return {
        ...state,
        phase: PHASE.RINGING,
        session: action.session,
        ringTimeoutSeconds: action.ringTimeoutSeconds || state.ringTimeoutSeconds,
      };
    case "CONNECTED":
      // Late "connected" after the person already gave up must not revive the screen
      return state.phase === PHASE.RINGING || state.phase === PHASE.STARTING ? { ...state, phase: PHASE.CONNECTED } : state;
    case "REMOTE_ENDED":
    case "HANGUP":
      if (state.phase === PHASE.CONNECTED) return { ...state, phase: PHASE.ENDED };
      if (state.phase === PHASE.RINGING) return { ...state, phase: PHASE.IDLE, session: null };
      return state;
    case "CANCEL":
      return state.phase === PHASE.RINGING || state.phase === PHASE.STARTING || state.phase === PHASE.CHECKING
        ? { ...state, phase: PHASE.IDLE, session: null }
        : state;
    case "RING_TIMEOUT":
      return state.phase === PHASE.RINGING ? fail(state, { code: "no_answer", sessionId: state.session && state.session.id }) : state;
    case "DECLINED":
      return state.phase === PHASE.RINGING ? fail(state, { code: "declined", sessionId: state.session && state.session.id }) : state;
    case "DROPPED":
      return state.phase === PHASE.CONNECTED || state.phase === PHASE.RINGING
        ? fail(state, { code: "dropped", sessionId: state.session && state.session.id })
        : state;
    case "FAILED":
      return state.phase === PHASE.IDLE || state.phase === PHASE.ENDED ? state : fail(state, action.failure || { code: "unknown" });
    case "SUPPORT_BUSY":
      return { ...state, supportBusy: true };
    case "SUPPORT_DONE":
      return { ...state, supportBusy: false, ticketId: action.ticketId || state.ticketId };
    case "SUPPORT_FAILED":
      return { ...state, supportBusy: false };
    case "DISMISS":
      return state.phase === PHASE.FAILED || state.phase === PHASE.ENDED ? initialState() : state;
    default:
      return state;
  }
}

function fail(state, failure) {
  return {
    ...state,
    phase: PHASE.FAILED,
    failure: { retry: !NO_RETRY.has(failure.code), ...failure },
    session: failure.sessionId ? state.session : null,
  };
}

// Turn whatever the API threw into a failure object. A thrown error with no
// HTTP status means the request never got through: the phone is offline.
export function failureFromError(err) {
  if (!err) return { code: "unknown" };
  const support = err.support || (err.data && err.data.support) || null;
  const sessionId = err.sessionId || (err.data && err.data.sessionId) || null;
  if (!err.status) return { code: "network", message: "No connection right now.", sessionId };
  if (err.status === 429) return { code: "rate_limited", message: err.message, support };
  if (err.status === 401) return { code: "signed_out", message: "Please sign in again.", retry: false };
  return { code: err.code || (err.status >= 500 ? "call_failed" : "unknown"), message: err.message, support, sessionId };
}

// What the failure sheet says. `canChat` is false only when we know chat is not possible.
export function failureView(failure, { counterpart = "them", canChat = true } = {}) {
  const f = failure || { code: "unknown" };
  const copy = {
    no_answer: [`${cap(counterpart)} didn't pick up`, "They may be driving or have no signal. Try again, or send a message."],
    declined: [`${cap(counterpart)} can't talk right now`, "Send a message instead, and they'll see it straight away."],
    dropped: ["The call dropped", "The connection was lost. Try again, or message them."],
    network: ["No connection", "Check your data or Wi-Fi, then try again."],
    rate_limited: ["Lots of calls in a short time", "Give it a few minutes, or message them instead."],
    calling_unavailable: ["Calling isn't available right now", "We're on it. Message them in the app, or talk to support."],
    call_failed: ["We couldn't connect the call", "Nothing you did. Try again, or message them."],
    no_driver: ["Calling opens soon", "You can call as soon as a driver accepts this ride."],
    not_active: ["Calling opens soon", "You can call once the driver has accepted the ride."],
    cancelled: ["This ride was cancelled", "Calls are only for active trips."],
    trip_over: ["This trip is over", "For anything about it, talk to support."],
    signed_out: ["Please sign in again", "Your session ended."],
    incoming_call: ["They're calling you right now", "Answer the call on your screen. If you can't see it, open the app again."],
    already_in_call: ["You're already on a call", "Finish or end the current call first."],
  };
  const [title, body] = copy[f.code] || ["Something went wrong", "Try again, or message them. Support is here if you need us."];
  const actions = [];
  if (f.retry !== false) actions.push("retry");
  if (canChat && !["no_driver", "not_active", "cancelled", "trip_over", "signed_out", "incoming_call", "already_in_call"].includes(f.code)) actions.push("chat");
  if (f.code !== "signed_out") actions.push("support");
  return { title, body, actions, reassurance: "We'll take care of you." };
}

function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

// Stream's calling states -> what to tell the server. `seen` remembers whether
// this device ever reached "joined" so a hang-up is reported as the right thing.
export function reportFor(prev, next, { isCaller, seen }) {
  if (prev === next) return null;
  if (next === "joined") return { event: "connected" };
  if (next === "reconnecting-failed" || next === "offline" && seen.joined) return { event: "failed", reason: "network" };
  if (next === "left" || next === "idle") {
    if (seen.joined) return { event: "ended" };
    if (prev === "ringing" || prev === "joining") return isCaller ? { event: "cancelled" } : { event: "declined" };
  }
  return null;
}

export function ringRemaining(startedAtMs, nowMs, timeoutSeconds) {
  return Math.max(0, Math.ceil(timeoutSeconds - (nowMs - startedAtMs) / 1000));
}
