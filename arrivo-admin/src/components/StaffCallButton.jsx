import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "../AuthContext";
import { useStreamClient } from "../StreamClientContext";
import * as api from "../api";
import { CallModal } from "./CallModal";

// Rings a rider or driver in their app from the workspace. The person sees the
// staff member's first name ("Tola from RideArrivo is calling"). No number is
// shown or dialled. Every attempt is recorded by the server.
//
// If it cannot connect the staff member is told plainly and can fall back to
// ringing from their own phone (logged) or try again.
export function StaffCallButton({ rideId, target, name, disabled, big }) {
  const { token } = useAuth();
  const { client, error: clientError } = useStreamClient();
  const [call, setCall] = useState(null);
  const [state, setState] = useState("idle"); // idle | starting | ringing | failed
  const [error, setError] = useState(null);
  const sessionRef = useRef(null);
  const busy = useRef(false);
  const unsub = useRef([]);

  const cleanup = useCallback(() => { unsub.current.forEach((f) => { try { f(); } catch (_) {} }); unsub.current = []; }, []);
  const report = useCallback((event, reason) => {
    if (sessionRef.current) api.reportCall(token, sessionRef.current, event, reason).catch(() => {});
  }, [token]);

  useEffect(() => () => { cleanup(); }, [cleanup]);
  // switching ride or person tears the call down so it never lingers
  useEffect(() => () => { if (call) call.leave().catch(() => {}); }, [call]);

  const start = async () => {
    if (busy.current || disabled) return;
    busy.current = true;
    setError(null);
    setState("starting");
    try {
      if (!client) throw Object.assign(new Error(clientError || "Calling isn't ready yet. Give it a moment."), { status: 503 });
      const res = await api.startStaffCall(token, rideId, target);
      sessionRef.current = res.session.id;
      const c = client.call(res.call.type, res.call.id);
      try {
        await c.get();
        await c.join();
      } catch (e) {
        report("failed", "join_error");
        throw Object.assign(new Error("We couldn't connect the call."), { status: 502 });
      }
      let answered = false;
      const sub = c.state.participants$.subscribe((ps) => {
        const n = Array.isArray(ps) ? ps.length : 0;
        if (n >= 2 && !answered) { answered = true; report("connected"); }
      });
      const sub2 = c.state.callingState$.subscribe((s) => {
        if (s === "left") report(answered ? "ended" : "cancelled");
        if (s === "reconnecting-failed") report("failed", "network");
      });
      const off = c.on("call.rejected", () => { report("declined"); closeCall(c); setError(`${name} can't talk right now.`); setState("failed"); });
      unsub.current.push(() => sub.unsubscribe(), () => sub2.unsubscribe(), off);
      setCall(c);
      setState("ringing");
    } catch (e) {
      setError(e.status ? e.message : "No connection. Check your internet and try again.");
      setState("failed");
    } finally {
      busy.current = false;
    }
  };

  const closeCall = async (c = call) => {
    cleanup();
    if (c) { try { await c.leave(); } catch (_) {} }
    setCall(null);
    setState((s) => (s === "failed" ? s : "idle"));
  };

  return (
    <div>
      <button
        className={`btn primary${big ? " desk-call-big" : ""}`}
        onClick={start}
        disabled={disabled || state === "starting" || !!call}
        title={disabled ? "Not available for this ride" : `Call ${name} in the app`}
      >
        {state === "starting" ? "Connecting…" : `📞 Call ${name} in the app`}
      </button>
      {state === "failed" && error ? (
        <div className="desk-callfail" role="alert">
          <strong>{error}</strong>
          <div>Try again, or ring from your own phone below. Both are logged.</div>
        </div>
      ) : null}
      <CallModal call={call} calleeName={name} onClose={() => closeCall()} />
    </div>
  );
}
