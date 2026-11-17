import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "../AuthContext";
import * as api from "../api";
import { StatusPill } from "../components/StatusPill";
import { formatDateTime } from "../utils";

// Which services each driver can work. A driver can hold more than one, and
// work from one service never reaches a driver who does not hold it. The owner
// has this page; anyone else only if the owner gave it to them on Team & Access.
// The backend enforces that (arrivo-backend/services/staffAccess.js), this page
// only shapes what is shown. PArAsYtE

const STATE_LABEL = { active: "On", requested: "Asked", revoked: "Withdrawn", off: "Off" };

export function DriverTiersPage() {
  const { token, isReadOnly } = useAuth();
  const [data, setData] = useState({ catalogue: [], drivers: [], you: { canManage: false } });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(null);
  const [ask, setAsk] = useState(null); // { driver, tier } while the dialog is open
  const [history, setHistory] = useState(null); // { driver, events }
  const searchTimer = useRef(null);

  const load = useCallback(async (term = "") => {
    try {
      const r = await api.getDriverTiers(token, term);
      setData(r);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => () => clearTimeout(searchTimer.current), []);

  const onSearch = (value) => {
    setQ(value);
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => load(value.trim()), 300);
  };

  const canManage = data.you?.canManage && !isReadOnly;
  const waiting = data.drivers.reduce((n, d) => n + d.waiting, 0);

  const apply = async (driver, tier, action, note) => {
    setBusy(driver.id);
    try {
      const fn = action === "grant" ? api.grantDriverTier : api.revokeDriverTier;
      const r = await fn(token, driver.id, tier.slug, note);
      setData((cur) => ({
        ...cur,
        drivers: cur.drivers.map((d) => (d.id === driver.id ? { ...d, tiers: r.tiers, waiting: r.tiers.filter((t) => t.status === "requested").length } : d)),
      }));
      setError(null);
      setAsk(null);
    } catch (e) {
      setError(e.message);
      setAsk((cur) => (cur ? { ...cur, problem: e.message } : cur));
    } finally {
      setBusy(null);
    }
  };

  const openHistory = async (driver) => {
    setHistory({ driver, events: null });
    try {
      const { events } = await api.getDriverTierEvents(token, driver.id);
      setHistory({ driver, events });
    } catch (e) {
      setHistory({ driver, events: [], problem: e.message });
    }
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <span className="eyebrow">Who works what</span>
          <h1>Driver Tiers</h1>
          <p className="tiers-lede">
            Switch services on for each driver. A driver can hold more than one, and each service only sends work to the drivers who hold it.
          </p>
        </div>
        <input
          className="field tiers-search"
          type="search"
          value={q}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="Search name, email, plate or ID"
          aria-label="Search drivers"
          maxLength={60}
        />
      </div>

      {!canManage && !loading && !error ? (
        <div className="tiers-note" role="note">You can look at this page but not change anything. Ask the owner for manage access.</div>
      ) : null}
      {waiting > 0 ? (
        <div className="tiers-note tiers-note-amber" role="status">
          {waiting} {waiting === 1 ? "service request is" : "service requests are"} waiting. They are listed first.
        </div>
      ) : null}
      {error ? <div className="tiers-note tiers-note-coral" role="alert">{error}</div> : null}

      {loading ? (
        <div className="empty-state">Loading…</div>
      ) : data.drivers.length === 0 ? (
        <div className="empty-state">{q ? "No drivers match that search." : "No drivers yet."}</div>
      ) : (
        <div className="tiers-grid">
          {data.drivers.map((d) => (
            <section className="tiers-card" key={d.id} aria-label={`Services for ${d.name}`}>
              <header className="tiers-card-head">
                <div className="tiers-who">
                  <strong title={d.name}>{d.name}</strong>
                  <small>{d.plate || "No vehicle yet"}{d.online ? " · Online" : ""}</small>
                </div>
                <div className="tiers-head-right">
                  <StatusPill label={d.verified ? "Verified" : "Not verified"} tone={d.verified ? "teal" : "amber"} />
                  <button type="button" className="btn ghost tiers-history-btn" onClick={() => openHistory(d)}>History</button>
                </div>
              </header>
              <div className="tiers-chips" role="group" aria-label={`Services for ${d.name}`}>
                {d.tiers.map((t) => (
                  <button
                    key={t.slug}
                    type="button"
                    className="tiers-chip"
                    data-state={t.status}
                    style={{ "--ta": t.accent }}
                    aria-pressed={t.status === "active"}
                    disabled={!canManage || busy === d.id}
                    onClick={() => setAsk({ driver: d, tier: t })}
                    title={t.live ? t.tagline : `${t.tagline} (work for this service is coming)`}
                  >
                    <i aria-hidden="true" />
                    <span>{t.name.replace(/^Arrivo/, "")}</span>
                    <small>{STATE_LABEL[t.status]}</small>
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {ask ? <TierDialog ask={ask} busy={busy === ask.driver.id} onClose={() => setAsk(null)} onApply={apply} /> : null}
      {history ? <HistoryDialog history={history} onClose={() => setHistory(null)} /> : null}
    </div>
  );
}

function TierDialog({ ask, busy, onClose, onApply }) {
  const { driver, tier } = ask;
  const [note, setNote] = useState("");
  const boxRef = useRef(null);
  useEffect(() => { boxRef.current?.focus(); }, []);
  const on = tier.status === "active";
  const waiting = tier.status === "requested";
  const needsReason = on || waiting;
  const tooShort = note.trim().length < 3;

  const title = on ? `Switch off ${tier.name} for ${driver.name}?` : waiting ? `${driver.name} asked for ${tier.name}` : `Switch on ${tier.name} for ${driver.name}?`;
  const body = on
    ? "They stop getting this service's work straight away. Their other services stay exactly as they are."
    : waiting
      ? "Approve to switch it on, or decline with a reason for the record."
      : "They can work this service from now on. Their other services stay exactly as they are.";

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-card tiers-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tiers-dialog-title"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
      >
        <h2 id="tiers-dialog-title">{title}</h2>
        <p className="tiers-dialog-body">{body}</p>
        {!tier.live && !on ? <p className="tiers-dialog-body tiers-dialog-soft">This service has no jobs in the app yet. Switching it on only records that they are allowed.</p> : null}
        <label className="tiers-label">
          {needsReason ? "Reason (required to switch off or decline)" : "Note (optional)"}
          <textarea ref={boxRef} className="field" rows={2} maxLength={240} value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        {ask.problem ? <div className="tiers-note tiers-note-coral" role="alert">{ask.problem}</div> : null}
        <div className="tiers-actions">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          {on ? (
            <button type="button" className="btn revoke" disabled={busy || tooShort} onClick={() => onApply(driver, tier, "revoke", note)}>Switch off</button>
          ) : waiting ? (
            <>
              <button type="button" className="btn revoke" disabled={busy || tooShort} onClick={() => onApply(driver, tier, "revoke", note)}>Decline</button>
              <button type="button" className="btn primary" disabled={busy} onClick={() => onApply(driver, tier, "grant", note)}>Approve</button>
            </>
          ) : (
            <button type="button" className="btn primary" disabled={busy} onClick={() => onApply(driver, tier, "grant", note)}>Switch on</button>
          )}
        </div>
      </div>
    </div>
  );
}

function HistoryDialog({ history, onClose }) {
  const { driver, events, problem } = history;
  const verb = { requested: "Asked for", granted: "Switched on", revoked: "Switched off" };
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-card tiers-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tiers-history-title"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
      >
        <h2 id="tiers-history-title">History for {driver.name}</h2>
        {events === null ? <p className="tiers-dialog-body">Loading…</p> : problem ? <div className="tiers-note tiers-note-coral">{problem}</div> : events.length === 0 ? (
          <p className="tiers-dialog-body">Nothing has changed for this driver yet.</p>
        ) : (
          <ol className="tiers-events">
            {events.map((e) => (
              <li key={e.id}>
                <strong>{verb[e.action] || e.action} {e.tier}</strong>
                <small>{formatDateTime(e.created_at)} · {e.actor_name || (e.action === "requested" ? "the driver" : "System")}</small>
                {e.note ? <span>{e.note}</span> : null}
              </li>
            ))}
          </ol>
        )}
        <div className="tiers-actions">
          <button type="button" className="btn ghost" autoFocus onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
