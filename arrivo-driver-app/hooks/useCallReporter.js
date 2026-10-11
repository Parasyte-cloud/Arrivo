import { useEffect, useRef } from "react";
import { useAuth } from "../context/AuthContext";
import { reportCallEvent } from "../services/api";
import { reportFor } from "../utils/callFlow";

// Tells the server what this phone saw happen on a ride call (answered, hung
// up, dropped), so the call history is accurate and support can see exactly
// what went wrong. Both sides report; the server treats repeats as harmless.
// Reporting must never get in the way of the call, so every failure is swallowed.
export function useCallReporter(call) {
  const { token, user } = useAuth();
  const seen = useRef({ joined: false });

  useEffect(() => {
    if (!call || !token) return undefined;
    const custom = call.state && call.state.custom;
    const sessionId = custom && custom.kind === "ride" ? custom.sessionId : null;
    if (!sessionId) return undefined;
    const createdBy = call.state.createdBy && call.state.createdBy.id;
    const isCaller = createdBy != null && String(createdBy) === String(user && user.id);

    let prev = call.state.callingState;
    seen.current = { joined: prev === "joined" };
    const sub = call.state.callingState$.subscribe((next) => {
      const report = reportFor(prev, next, { isCaller, seen: seen.current });
      if (next === "joined") seen.current.joined = true;
      prev = next;
      if (report) reportCallEvent(token, sessionId, report.event, report.reason).catch(() => {});
    });
    return () => sub.unsubscribe();
  }, [call, token, user]);
}
