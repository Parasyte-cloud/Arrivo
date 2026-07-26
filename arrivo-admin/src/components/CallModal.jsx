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
      <div style={{ width: "100%", maxWidth: 720, background: "var(--bg1)", borderRadius: 16, overflow: "hidden" }}>
        <StreamCall call={call}>
          <CallUI calleeName={calleeName} onClose={onClose} />
        </StreamCall>
      </div>
    </div>
  );
}
