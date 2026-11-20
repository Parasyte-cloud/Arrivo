import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../AuthContext";
import * as api from "../api";
import { formatDateTime } from "../utils";

// PArAsYtE | ArrivoOps
// Fares kept as wallet credit after a cancelled arrival flight (backend: services/flightCredit.js).
// Search by rider name, passenger surname, email, phone, flight or ride number. A credit can be moved
// to the account that should really have it (a PA, a relative); the backend refuses if it is spent.

const naira = (n) => `₦${Math.round(Number(n) || 0).toLocaleString("en-NG")}`;
const daysOld = (iso) => Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86400000));

export function FlightCredits() {
  const { token, can } = useAuth();
  const canMove = can("flight-issues", "manage");
  const [q, setQ] = useState("");
  const [rows, setRows] = useState([]);
  const [enabled, setEnabled] = useState(true);
  const [reviewAfter, setReviewAfter] = useState(180);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [moving, setMoving] = useState(null); // credit being moved
  const [target, setTarget] = useState("");
  const [accounts, setAccounts] = useState([]);
  const [chosen, setChosen] = useState(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);

  const load = useCallback(async (query) => {
    try {
      const r = await api.getFlightCredits(token, query);
      setRows(r.credits);
      setEnabled(r.enabled);
      setReviewAfter(typeof r.reviewAfterDays === "number" ? r.reviewAfterDays : 180);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    const t = setTimeout(() => load(q), 250);
    return () => clearTimeout(t);
  }, [q, load]);

  useEffect(() => {
    if (!moving || target.trim().length < 2) { setAccounts([]); return undefined; }
    const t = setTimeout(() => {
      api.findCreditAccounts(token, target).then((r) => setAccounts(r.accounts)).catch(() => setAccounts([]));
    }, 250);
    return () => clearTimeout(t);
  }, [target, moving, token]);

  const startMove = (c) => { setMoving(c); setTarget(""); setAccounts([]); setChosen(null); setNote(""); setDone(null); };

  const confirmMove = async () => {
    if (!moving || !chosen) return;
    setBusy(true);
    try {
      await api.moveFlightCredit(token, moving.id, chosen.id, note);
      setDone(`${naira(moving.amount_naira)} moved to ${chosen.name}.`);
      setMoving(null);
      await load(q);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      {!enabled ? (
        <div className="error-text" style={{ marginBottom: 12 }}>
          Flight credit is switched off on the server (FLIGHT_CANCEL_CREDIT). Nothing new is credited automatically.
        </div>
      ) : null}
      {done ? <div style={{ color: "var(--green, #1a7f37)", fontWeight: 600, marginBottom: 12 }}>{done}</div> : null}
      {error ? <div className="error-text" style={{ marginBottom: 12 }}>{error}</div> : null}

      <input
        className="field"
        style={{ maxWidth: 460, marginBottom: 16 }}
        placeholder="Search name, surname, email, phone, flight or ride number"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        aria-label="Search flight credits"
      />

      {loading ? (
        <div className="empty-state">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="table-wrap"><div className="empty-state">{q ? "No credit matches that search." : "No flight credits yet."}</div></div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {rows.map((c) => (
            <div key={c.id} className="alert-card warning">
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 15 }}>{naira(c.amount_naira)} · Ride #{c.ride_id}</div>
                  <div style={{ fontSize: 12.5, color: "var(--text-muted)", marginTop: 4 }}>
                    Flight {c.flight_number || "?"}{c.flight_date_str ? ` on ${c.flight_date_str}` : ""}{c.passenger_surname ? ` · passenger ${c.passenger_surname}` : ""}
                  </div>
                  <div style={{ fontSize: 12.5, color: "var(--text-muted)" }}>
                    Credited {formatDateTime(c.created_at)} ({daysOld(c.created_at)} days ago) · {c.source === "ops" ? "by Ops" : "automatic"}
                  </div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <span className="badge">{c.status === "moved" ? "Moved" : "Held"}</span>
                  {c.status === "held" && reviewAfter > 0 && daysOld(c.created_at) >= reviewAfter ? (
                    <div style={{ marginTop: 6, fontSize: 12.5, fontWeight: 700 }}>Needs a call: unused for {reviewAfter}+ days</div>
                  ) : null}
                  {c.status === "held" && canMove ? (
                    <div><button type="button" className="btn btn-ghost" style={{ marginTop: 8 }} onClick={() => startMove(c)}>Move to another account</button></div>
                  ) : null}
                </div>
              </div>
              <div style={{ marginTop: 10, fontSize: 13.5 }}>
                <strong>{c.rider_name}</strong> · {c.rider_email}{c.rider_phone ? ` · ${c.rider_phone}` : ""}
                <div style={{ color: "var(--text-muted)", fontSize: 12.5 }}>Wallet now: {naira(c.rider_wallet_naira)}</div>
              </div>

              {moving && moving.id === c.id ? (
                <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid var(--border, #e3e6ea)" }}>
                  <label className="field-label" htmlFor={`acct-${c.id}`}>Find the account that should have it (name, email or phone)</label>
                  <input id={`acct-${c.id}`} className="field" value={target} onChange={(e) => { setTarget(e.target.value); setChosen(null); }} />
                  {accounts.map((a) => (
                    <button type="button" key={a.id} className={`btn ${chosen && chosen.id === a.id ? "btn-primary" : "btn-ghost"}`} style={{ display: "block", marginTop: 6, textAlign: "left" }} onClick={() => setChosen(a)}>
                      {a.name} · {a.email}{a.phone ? ` · ${a.phone}` : ""}
                    </button>
                  ))}
                  <label className="field-label" htmlFor={`note-${c.id}`} style={{ marginTop: 10, display: "block" }}>Why (kept in the audit trail)</label>
                  <input id={`note-${c.id}`} className="field" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />
                  <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
                    <button type="button" className="btn btn-primary" disabled={!chosen || busy} onClick={confirmMove}>
                      {busy ? "Moving…" : chosen ? `Move ${naira(c.amount_naira)} to ${chosen.name}` : "Choose an account"}
                    </button>
                    <button type="button" className="btn btn-ghost" onClick={() => setMoving(null)}>Cancel</button>
                  </div>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
