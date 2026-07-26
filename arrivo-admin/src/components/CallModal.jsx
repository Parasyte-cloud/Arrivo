import { useEffect, useRef } from "react";
import "@stream-io/video-react-sdk/dist/css/styles.css";
import {
  StreamCall,
  StreamTheme,
  SpeakerLayout,
  CallControls,
  useCallStateHooks,
  CallingState,
} from "@stream-io/video-react-sdk";

// Admin/support only ever PLACE calls (never receive one), so there's no
// ringing screen to render here for THIS side — just "Calling…" until the
// other party (rider or driver) answers, then the normal in-call layout.
// The rider/driver side still sees their own native ringing UI exactly as
// it already does for rider<->driver calls (see each mobile app's
// components/CallOverlay.js) — this call is indistinguishable to them from
// any other incoming call.
function CallUI({ calleeName, onClose }) {
  const { useCallCallingState } = useCallStateHooks();
  const callingState = useCallCallingState();
  const wasJoinedRef = useRef(false);

  // Nothing else in this file watches for the other party leaving — once
  // they hang up, the calling state moves from JOINED to LEFT (or IDLE)
  // and, without this, the modal would just sit there showing a dead call
  // until the admin manually clicks a control. Only auto-close once we've
  // actually been JOINED at some point, so the normal "Calling…" pre-answer
  // state (which also isn't JOINED) doesn't trigger an immediate close.
  useEffect(() => {
    if (callingState === CallingState.JOINED) {
      wasJoinedRef.current = true;
      return;
    }
    if (wasJoinedRef.current && (callingState === CallingState.LEFT || callingState === CallingState.IDLE)) {
      onClose();
    }
  }, [callingState, onClose]);

  return (
    <StreamTheme>
      {callingState === CallingState.JOINED ? (
        <SpeakerLayout />
      ) : (
        <div style={{ padding: 40, textAlign: "center", color: "var(--text)" }}>
          Calling {calleeName}…
        </div>
      )}
      <CallControls onLeave={onClose} />
    </StreamTheme>
  );
}

export function CallModal({ call, calleeName, onClose }) {
  if (!call) return null;

  return (
    <div className="modal-backdrop" style={{ zIndex: 200 }}>
      <div className="modal-card" style={{ maxWidth: 720, overflow: "hidden" }}>
        <StreamCall call={call}>
          <CallUI calleeName={calleeName} onClose={onClose} />
        </StreamCall>
      </div>
    </div>
  );
}
