import { useEffect, useState } from "react";
import { useStreamClient } from "../StreamClientContext";
import { CallModal } from "./CallModal";

// Drop-in "Call" button for any rider/driver row (RidersPage, DriversPage).
// calleeUserId must be the target's raw users.id — for riders that's
// already what the admin API returns as `id`; for drivers it's `user_id`
// (drivers.id, the row's own `id`, is a DIFFERENT number — see
// arrivo-backend/routes/admin.js GET /drivers, which already joins and
// selects users.id as user_id for exactly this reason).
export function CallButton({ calleeUserId, calleeName }) {
  const { client, error: clientError } = useStreamClient();
  const [call, setCall] = useState(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState(null);

  // Without this, switching sidebar tabs mid-call (App.jsx conditionally
  // unmounts whole pages, e.g. {page === "riders" && <RidersPage/>}) tears
  // down this component tree without ever calling call.leave() — the call
  // just stays joined server-side. Runs on every `call` change (so ending a
  // call and starting a new one still cleans up the previous one) and on
  // unmount.
  useEffect(() => {
    return () => {
      call?.leave().catch(() => {});
    };
  }, [call]);

  const startCall = async () => {
    if (!calleeUserId) return;
    if (!client) {
      setError(clientError || "Calling isn't ready yet — try again in a moment.");
      return;
    }
    setStarting(true);
    setError(null);
    try {
      const newCall = client.call("default", crypto.randomUUID());
      await newCall.getOrCreate({
        ring: true,
        video: false,
        data: {
          members: [{ user_id: client.streamClient.userID }, { user_id: String(calleeUserId) }],
        },
      });
      setCall(newCall);
    } catch (e) {
      setError(e.message || "Couldn't start the call.");
    } finally {
      setStarting(false);
    }
  };

  const endCall = async () => {
    try {
      await call?.leave();
    } catch {
      // already ended / left — nothing more to do
    }
    setCall(null);
  };

  return (
    <>
      <button className="btn" disabled={starting || !!call} onClick={startCall} title={`Call ${calleeName || "this user"}`}>
        {starting ? "…" : "📞 Call"}
      </button>
      {error ? <div className="error-text" style={{ fontSize: 11, marginTop: 4 }}>{error}</div> : null}
      <CallModal call={call} calleeName={calleeName} onClose={endCall} />
    </>
  );
}
