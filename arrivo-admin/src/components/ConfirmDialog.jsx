import React, { useEffect, useRef, useState } from "react";

// In-page replacements for window.confirm / window.prompt / window.alert.
// Native dialogs block the whole page and are silently suppressed or hang inside embedded
// frames, pop-out windows and some desktop shells, which left the console frozen mid-action.
// These render inside the page, work everywhere, and can always be cancelled with Esc.
let host = null;
const enqueue = (req) => new Promise((resolve) => {
  if (!host) { resolve(req.kind === "ask" ? null : false); return; }
  host({ ...req, resolve });
});

export const confirmAction = (message, opts = {}) => enqueue({ kind: "confirm", message, ...opts });
export const askText = (message, opts = {}) => enqueue({ kind: "ask", message, ...opts });
export const notify = (message) => enqueue({ kind: "notify", message });

export function ConfirmHost() {
  const [queue, setQueue] = useState([]);
  const [text, setText] = useState("");
  const okRef = useRef(null);
  useEffect(() => {
    host = (req) => setQueue((q) => [...q, req]);
    return () => { host = null; };
  }, []);
  const cur = queue[0];
  useEffect(() => { setText(""); if (cur && cur.kind !== "ask") setTimeout(() => okRef.current && okRef.current.focus(), 0); }, [cur]);
  if (!cur) return null;
  const close = (value) => { cur.resolve(value); setQueue((q) => q.slice(1)); };
  const cancelValue = cur.kind === "ask" ? null : false;
  const danger = cur.danger !== false && cur.kind === "confirm" && /delete|cancel|cannot be undone|can't be undone|for good|offline|bypass/i.test(cur.message);
  return (
    <div className="modal-backdrop confirm-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget && cur.kind !== "notify") close(cancelValue); }}
      onKeyDown={(e) => { if (e.key === "Escape") close(cancelValue); }}>
      <div className="modal-card confirm-card" role="alertdialog" aria-modal="true" aria-label="Please confirm">
        <p className="confirm-text">{cur.message}</p>
        {cur.kind === "ask" ? (
          <input className="field" style={{ width: "100%", marginTop: 10 }} value={text} onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && (!cur.required || text.trim())) close(text); }} autoFocus />
        ) : null}
        <div className="confirm-actions">
          {cur.kind !== "notify" ? <button type="button" className="btn ghost" onClick={() => close(cancelValue)}>Cancel</button> : null}
          <button type="button" ref={okRef} disabled={cur.kind === "ask" && cur.required && !text.trim()} className={`btn ${danger ? "revoke" : "primary"}`} onClick={() => close(cur.kind === "ask" ? text : true)}>
            {cur.confirmLabel || (cur.kind === "notify" ? "OK" : danger ? "Yes, do it" : "Confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
