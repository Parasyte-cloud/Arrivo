import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../AuthContext";
import * as api from "../api";
import { StatusPill } from "../components/StatusPill";
import { formatDateTime } from "../utils";

// Trip safety: reports from riders and drivers, driver selfie review, pickup
// PIN overrides, and the two switches. Admin only. English inline, like the
// rest of this app.

const TABS = [
  { id: "complaints", label: "Reports" },
  { id: "selfies", label: "Selfie review" },
  { id: "pin", label: "Pickup PIN" },
  { id: "switches", label: "Switches" },
  { id: "events", label: "Audit trail" },
];

const LABELS = {
  unsafe_driving: "Unsafe driving", harassment: "Harassment", felt_unsafe: "Felt unsafe", wrong_route: "Wrong route",
  overcharge: "Overcharge", vehicle_mismatch: "Car or plate did not match", rude: "Rude", other: "Other",
  aggressive: "Aggressive", damage: "Damage", no_show: "No show", unsafe_request: "Unsafe request", intoxicated: "Intoxicated",
};
const ACTIONS_FOR_DRIVER = [["none", "No action"], ["warn", "Warn"], ["pause_driver", "Pause driver's Express"], ["resume_driver", "Resume driver's Express"], ["require_selfie", "Require a new selfie"]];
const ACTIONS_FOR_RIDER = [["none", "No action"], ["warn", "Warn"], ["restrict_rider", "Restrict rider from Express"], ["unrestrict_rider", "Lift restriction"]];

const SWITCH_COPY = {
  safety_pickup_pin_required: {
    title: "Require the pickup PIN",
    body: "Drivers must type the rider's 4 digit PIN before an ArrivoExpress trip can start. Only turn this on after the rider app and driver app versions that show and ask for the PIN are released, or drivers on old versions will not be able to start trips.",
  },
  safety_selfie_required: {
    title: "Require the driver selfie check",
    body: "Drivers must pass a selfie check before going online. Review is manual: you compare the selfie with the profile photo. Only turn this on after the driver app version with the camera screen is released, or drivers on old versions cannot go online.",
  },
};

function useLoad(fn, deps) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    try { setData(await fn()); setError(null); } catch (e) { setError(e.message); } finally { setLoading(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { load(); }, [load]);
  return { data, error, loading, reload: load };
}

function Note({ children }) {
  return <p style={{ color: "var(--text-muted)", fontSize: 12.5, margin: "0 0 14px" }}>{children}</p>;
}

function ComplaintsTab({ token }) {
  const [status, setStatus] = useState("open");
  const list = useLoad(() => api.getSafetyComplaints(token, status), [token, status]);
  const [openId, setOpenId] = useState(null);
  const [note, setNote] = useState("");
  const [action, setAction] = useState("none");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const rows = list.data ? list.data.complaints : [];

  const act = async (c, newStatus) => {
    setBusy(true); setErr(null);
    try {
      await api.resolveSafetyComplaint(token, c.id, { status: newStatus, resolution: note, action });
      setOpenId(null); setNote(""); setAction("none");
      await list.reload();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  return (
    <div>
      <Note>
        Urgent reports must be answered within 1 hour, others within 24. Overdue ones are marked in red. The person reported never sees
        these. Two different riders filing urgent reports on one driver in 14 days pauses that driver's Express automatically; check those here.
      </Note>
      <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
        {[["open", "Open"], ["investigating", "Investigating"], ["resolved", "Resolved"], ["dismissed", "Dismissed"], [undefined, "All"]].map(([s, label]) => (
          <button key={label} className={`btn ${status === s ? "primary" : "ghost"}`} onClick={() => setStatus(s)}>{label}</button>
        ))}
      </div>
      {list.error ? <div className="error-text">{list.error}</div> : null}
      {err ? <div className="error-text">{err}</div> : null}
      {!list.loading && !rows.length ? <div className="empty-state">No reports here.</div> : null}
      {rows.map((c) => {
        const closed = ["resolved", "dismissed"].includes(c.status);
        const actions = c.filer_role === "rider" ? ACTIONS_FOR_DRIVER : ACTIONS_FOR_RIDER;
        return (
          <div key={c.id} className="table-wrap" style={{ padding: 16, marginBottom: 12, borderLeft: c.overdue ? "3px solid var(--coral)" : c.priority === "urgent" ? "3px solid var(--amber)" : undefined }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 6 }}>
              <strong>#{c.id} {LABELS[c.category] || c.category}</strong>
              <StatusPill label={c.priority} tone={c.priority === "urgent" ? "coral" : "muted"} />
              <StatusPill label={c.status} tone={closed ? "teal" : "amber"} />
              {c.overdue ? <StatusPill label="overdue" tone="coral" /> : null}
              <span style={{ color: "var(--text-muted)", fontSize: 12 }}>Ride {c.ride_id} · respond by {formatDateTime(c.respond_by)}</span>
            </div>
            <div style={{ fontSize: 13, marginBottom: 6 }}>
              <strong>{c.filer_name}</strong> ({c.filer_role}) reported <strong>{c.against_name}</strong> ({c.filer_role === "rider" ? "driver" : "rider"}).
              {c.other_reports_against > 0 ? <span style={{ color: "var(--coral)" }}> {c.other_reports_against} other report{c.other_reports_against === 1 ? "" : "s"} against them.</span> : null}
            </div>
            <div style={{ fontSize: 13.5, marginBottom: 8, whiteSpace: "pre-wrap" }}>{c.description}</div>
            {c.photo_data_url ? <img src={c.photo_data_url} alt="Evidence" style={{ maxWidth: 240, maxHeight: 200, borderRadius: 8, marginBottom: 8 }} /> : null}
            {closed ? (
              <div style={{ fontSize: 12.5, color: "var(--text-muted)" }}>Outcome: {c.resolution} {c.action && c.action !== "none" ? `(${c.action})` : ""}</div>
            ) : openId === c.id ? (
              <div>
                <select value={action} onChange={(e) => setAction(e.target.value)} style={{ marginBottom: 8, display: "block" }}>
                  {actions.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
                <textarea className="notes" rows={3} placeholder="Outcome note (shown to the person who reported, at least 5 characters)" value={note} onChange={(e) => setNote(e.target.value)} />
                <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                  <button className="btn primary" disabled={busy} onClick={() => act(c, "resolved")}>Resolve</button>
                  <button className="btn ghost" disabled={busy} onClick={() => act(c, "dismissed")}>Dismiss</button>
                  <button className="btn ghost" disabled={busy} onClick={() => act(c, "investigating")}>Mark investigating</button>
                  <button className="btn ghost" onClick={() => setOpenId(null)}>Cancel</button>
                </div>
              </div>
            ) : (
              <button className="btn ghost" onClick={() => { setOpenId(c.id); setNote(""); setAction("none"); }}>Review</button>
            )}
          </div>
        );
      })}
    </div>
  );
}

function SelfiesTab({ token }) {
  const list = useLoad(() => api.getSafetySelfies(token), [token]);
  const [busyId, setBusyId] = useState(null);
  const [err, setErr] = useState(null);
  const rows = list.data ? list.data.selfies : [];
  const decide = async (s, decision) => {
    let note = "";
    if (decision === "rejected") {
      note = window.prompt(`Why reject ${s.driver_name}'s selfie? (shown to the driver)`) || "";
      if (!note) return;
    }
    setBusyId(s.id); setErr(null);
    try { await api.reviewSafetySelfie(token, s.id, { decision, note }); await list.reload(); }
    catch (e) { setErr(e.message); } finally { setBusyId(null); }
  };
  return (
    <div>
      <Note>
        Compare the selfie (left) with the profile photo (right) by eye, and check the code word on the paper matches. There is no automatic
        face matching yet. A driver whose selfie is waiting here is still allowed online for 24 hours; a rejected one is blocked until they send a new one.
      </Note>
      {list.error ? <div className="error-text">{list.error}</div> : null}
      {err ? <div className="error-text">{err}</div> : null}
      {!list.loading && !rows.length ? <div className="empty-state">Nothing waiting for review.</div> : null}
      {rows.map((s) => (
        <div key={s.id} className="table-wrap" style={{ padding: 16, marginBottom: 12 }}>
          <div style={{ marginBottom: 8 }}><strong>{s.driver_name}</strong> · code shown: <strong>{s.challenge}</strong> · {formatDateTime(s.created_at)}</div>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 10 }}>
            <img src={s.image_data_url} alt="Selfie" style={{ maxWidth: 220, maxHeight: 260, borderRadius: 8 }} />
            {s.profile_photo_url ? <img src={s.profile_photo_url} alt="Profile" style={{ maxWidth: 220, maxHeight: 260, borderRadius: 8 }} /> : <span style={{ color: "var(--text-muted)" }}>No profile photo on file.</span>}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn primary" disabled={busyId === s.id} onClick={() => decide(s, "approved")}>Approve</button>
            <button className="btn ghost" disabled={busyId === s.id} onClick={() => decide(s, "rejected")}>Reject</button>
            <button className="btn ghost" disabled={busyId === s.id} onClick={async () => {
              if (!window.confirm(`Take ${s.driver_name} offline and require a new selfie?`)) return;
              try { await api.requireDriverRecheck(token, s.driver_id); await list.reload(); } catch (e) { setErr(e.message); }
            }}>Require new selfie</button>
          </div>
        </div>
      ))}
    </div>
  );
}

function PinTab({ token }) {
  const [rideId, setRideId] = useState("");
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    if (!window.confirm(`Let the driver start ride ${rideId} without the PIN? This is recorded with your name and reason.`)) return;
    setBusy(true); setErr(null); setMsg(null);
    try { await api.overridePickupPin(token, Number(rideId), note); setMsg(`Done. The driver can now start ride ${rideId}.`); setRideId(""); setNote(""); }
    catch (e2) { setErr(e2.message); } finally { setBusy(false); }
  };
  return (
    <form className="table-wrap" style={{ padding: 18, maxWidth: 520 }} onSubmit={submit}>
      <Note>Use this when a rider cannot show their PIN (phone died) and you have confirmed they are the right person. The reason is required and kept in the audit trail.</Note>
      <input type="number" min="1" placeholder="Ride number" value={rideId} onChange={(e) => setRideId(e.target.value)} required style={{ display: "block", marginBottom: 8 }} />
      <textarea className="notes" rows={3} placeholder="Why the PIN is being skipped (at least 10 characters)" value={note} onChange={(e) => setNote(e.target.value)} required />
      {err ? <div className="error-text">{err}</div> : null}
      {msg ? <div style={{ color: "var(--teal)", fontSize: 13, margin: "8px 0" }}>{msg}</div> : null}
      <button className="btn primary" disabled={busy} type="submit" style={{ marginTop: 8 }}>{busy ? "Saving…" : "Skip the PIN for this ride"}</button>
    </form>
  );
}

function SwitchesTab({ token }) {
  const o = useLoad(() => api.getSafetyOverview(token), [token]);
  const [err, setErr] = useState(null);
  const toggle = async (sw) => {
    const copy = SWITCH_COPY[sw.key];
    const turningOn = !sw.enabled;
    if (turningOn && !window.confirm(`Turn ON: ${copy.title}?\n\n${copy.body}`)) return;
    if (!turningOn && !window.confirm(`Turn OFF: ${copy.title}?`)) return;
    try { await api.setSafetySwitch(token, sw.key, turningOn); await o.reload(); } catch (e) { setErr(e.message); }
  };
  const sws = o.data ? o.data.switches : [];
  return (
    <div>
      <Note>Both are off until you turn them on. Expiring share links and two-way reports are always on and have no switch.</Note>
      {o.error ? <div className="error-text">{o.error}</div> : null}
      {err ? <div className="error-text">{err}</div> : null}
      {sws.map((sw) => (
        <div key={sw.key} className="table-wrap" style={{ padding: 16, marginBottom: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <div>
              <strong>{SWITCH_COPY[sw.key].title}</strong> <StatusPill label={sw.enabled ? "ON" : "OFF"} tone={sw.enabled ? "teal" : "muted"} />
              <div style={{ color: "var(--text-muted)", fontSize: 12.5, marginTop: 4, maxWidth: 560 }}>{SWITCH_COPY[sw.key].body}</div>
            </div>
            <button className={`btn ${sw.enabled ? "ghost" : "primary"}`} onClick={() => toggle(sw)}>{sw.enabled ? "Turn off" : "Turn on"}</button>
          </div>
        </div>
      ))}
      {o.data ? (
        <Note>
          Open reports: {o.data.complaints.open} (urgent {o.data.complaints.urgent}, overdue {o.data.complaints.overdue}) · selfies waiting: {o.data.pendingSelfies} · drivers with Express paused: {o.data.pausedDrivers}
        </Note>
      ) : null}
    </div>
  );
}

function EventsTab({ token }) {
  const ev = useLoad(() => api.getSafetyEvents(token), [token]);
  const rows = ev.data ? ev.data.events : [];
  return (
    <div className="table-wrap">
      {ev.error ? <div className="error-text">{ev.error}</div> : null}
      <table>
        <thead><tr><th>When</th><th>What</th><th>Ride</th><th>Detail</th></tr></thead>
        <tbody>
          {rows.map((e) => (
            <tr key={e.id}>
              <td>{formatDateTime(e.created_at)}</td>
              <td>{e.kind}</td>
              <td>{e.ride_id || ""}</td>
              <td style={{ fontSize: 12, color: "var(--text-muted)" }}>{JSON.stringify(e.detail)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!ev.loading && !rows.length ? <div className="empty-state">Nothing recorded yet.</div> : null}
    </div>
  );
}

export function SafetyPage() {
  const { token, user } = useAuth();
  const [tab, setTab] = useState("complaints");
  if (user && user.role !== "admin") {
    return <div className="empty-state">Trip safety is for administrators only.</div>;
  }
  return (
    <div>
      <div className="page-header">
        <div>
          <span className="eyebrow">Trip safety</span>
          <h1>Reports, selfie checks and PINs</h1>
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, marginBottom: 20, flexWrap: "wrap" }}>
        {TABS.map((t) => (
          <button key={t.id} className={`btn ${tab === t.id ? "primary" : "ghost"}`} onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </div>
      {tab === "complaints" ? <ComplaintsTab token={token} /> : null}
      {tab === "selfies" ? <SelfiesTab token={token} /> : null}
      {tab === "pin" ? <PinTab token={token} /> : null}
      {tab === "switches" ? <SwitchesTab token={token} /> : null}
      {tab === "events" ? <EventsTab token={token} /> : null}
    </div>
  );
}
