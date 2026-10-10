import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../AuthContext";
import * as api from "../api";
import { StatusPill } from "../components/StatusPill";
import { formatDateTime } from "../utils";

// ArrivoExpress money controls. Admin only (the operations role is read-only
// elsewhere and is not given these). Text is English inline, like the rest of
// this app.

const TABS = [
  { id: "prices", label: "Prices" },
  { id: "market", label: "Market" },
  { id: "quests", label: "Driver quests" },
  { id: "payouts", label: "Payouts" },
  { id: "automation", label: "Automation" },
];

const TIERS = ["economy", "comfort", "xl", "premium"];
const SOURCES = ["bolt", "uber", "indrive", "other"];
const naira = (n) => `₦${Number(n || 0).toLocaleString()}`;

// Shared hook: load something, keep error and loading state.
function useLoad(fn, deps) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    try {
      setData(await fn());
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { load(); }, [load]);
  return { data, error, loading, reload: load };
}

function Note({ children }) {
  return <p style={{ color: "var(--text-muted)", fontSize: 12.5, margin: "0 0 14px" }}>{children}</p>;
}

// ── Prices ───────────────────────────────────────────────────────────────
const PRICE_FIELDS = [
  ["baseFareNaira", "Base"],
  ["perKmNaira", "Per km"],
  ["perMinNaira", "Per min"],
  ["minimumFareNaira", "Minimum"],
];

function PricesTab({ token }) {
  const prices = useLoad(() => api.getExpressPrices(token), [token]);
  const history = useLoad(() => api.getExpressPriceHistory(token), [token]);
  const [drafts, setDrafts] = useState({});
  const [note, setNote] = useState("");
  const [when, setWhen] = useState("");
  const [confirmLarge, setConfirmLarge] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [err, setErr] = useState(null);

  const sheet = prices.data ? prices.data.prices : [];
  const valueOf = (row, f) => (drafts[row.tier] && drafts[row.tier][f] !== undefined ? drafts[row.tier][f] : row[f]);
  const changedTiers = sheet.filter((row) => PRICE_FIELDS.some(([f]) => String(valueOf(row, f)) !== String(row[f])));

  const publish = async () => {
    setBusy(true); setErr(null); setMsg(null);
    try {
      const tiers = {};
      for (const row of changedTiers) {
        tiers[row.tier] = {};
        for (const [f] of PRICE_FIELDS) tiers[row.tier][f] = Number(valueOf(row, f));
      }
      const body = { tiers, note, confirmLargeChange: confirmLarge };
      if (when) body.effectiveFrom = new Date(when).toISOString();
      await api.publishExpressPrices(token, body);
      setDrafts({}); setNote(""); setWhen(""); setConfirmLarge(false);
      setMsg(`Published ${changedTiers.length} tier${changedTiers.length === 1 ? "" : "s"}.`);
      await Promise.all([prices.reload(), history.reload()]);
    } catch (e) {
      setErr(e.message);
      if (/confirmLargeChange/.test(e.message)) setConfirmLarge(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <Note>
        Edit a number and publish. It applies to the next quote, or at the time you pick. A change over 25% is refused
        unless you tick the box and explain why. Nothing here changes a ride already booked.
      </Note>
      {prices.error ? <div className="error-text">{prices.error}</div> : null}
      <div className="table-wrap" style={{ marginBottom: 20 }}>
        <table>
          <thead>
            <tr><th>Tier</th>{PRICE_FIELDS.map(([f, label]) => <th key={f}>{label} (₦)</th>)}<th>Source</th></tr>
          </thead>
          <tbody>
            {sheet.map((row) => (
              <tr key={row.tier}>
                <td style={{ fontWeight: 600, textTransform: "capitalize" }}>{row.tier}</td>
                {PRICE_FIELDS.map(([f]) => (
                  <td key={f}>
                    <input
                      className="field" type="number" min="0" style={{ width: 100, marginBottom: 0 }}
                      value={valueOf(row, f)}
                      onChange={(e) => setDrafts((d) => ({ ...d, [row.tier]: { ...(d[row.tier] || {}), [f]: e.target.value } }))}
                    />
                  </td>
                ))}
                <td><StatusPill label={row.source === "price_book" ? "Published" : "Code default"} tone={row.source === "price_book" ? "amber" : "muted"} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="table-wrap" style={{ padding: 18, marginBottom: 28 }}>
        <input className="field" placeholder="Why? (for example: fuel up 8%)" value={note} onChange={(e) => setNote(e.target.value)} />
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <label style={{ fontSize: 12.5, color: "var(--text-muted)" }}>
            Starts{" "}
            <input className="field" type="datetime-local" style={{ width: 220, marginBottom: 0 }} value={when} onChange={(e) => setWhen(e.target.value)} />
            {" "}(blank means now)
          </label>
          <label style={{ fontSize: 12.5 }}>
            <input type="checkbox" checked={confirmLarge} onChange={(e) => setConfirmLarge(e.target.checked)} /> I mean a change over 25%
          </label>
          <button className="btn primary" disabled={busy || !changedTiers.length} onClick={publish}>
            {busy ? "Publishing…" : `Publish ${changedTiers.length || ""} change${changedTiers.length === 1 ? "" : "s"}`}
          </button>
        </div>
        {err ? <div className="error-text" style={{ marginTop: 10 }}>{err}</div> : null}
        {msg ? <div style={{ marginTop: 10, color: "var(--teal)", fontSize: 13 }}>{msg}</div> : null}
      </div>

      <h3 style={{ marginBottom: 10 }}>History</h3>
      <div className="table-wrap">
        {history.data && history.data.history.length ? (
          <table>
            <thead><tr><th>Tier</th><th>Base</th><th>Per km</th><th>Per min</th><th>Minimum</th><th>Starts</th><th>By</th><th>Note</th></tr></thead>
            <tbody>
              {history.data.history.map((h) => (
                <tr key={h.id}>
                  <td style={{ textTransform: "capitalize" }}>{h.tier}</td>
                  <td>{naira(h.baseFareNaira)}</td><td>{naira(h.perKmNaira)}</td><td>{naira(h.perMinNaira)}</td><td>{naira(h.minimumFareNaira)}</td>
                  <td>{formatDateTime(h.effectiveFrom)}</td>
                  <td>{h.publishedBy || (h.note && h.note.startsWith("AUTO:") ? "Automatic" : "")}</td>
                  <td style={{ color: "var(--text-muted)", fontSize: 12.5 }}>{h.note || ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <div className="empty-state">Nothing published yet. All tiers use the code defaults.</div>}
      </div>
    </div>
  );
}

// ── Market ───────────────────────────────────────────────────────────────
const VERDICTS = {
  above_market: { label: "Dearer than market", tone: "coral" },
  below_market: { label: "Cheaper than market", tone: "amber" },
  in_line: { label: "In line", tone: "teal" },
  not_enough_data: { label: "Not enough data", tone: "muted" },
};

function MarketTab({ token }) {
  const [days, setDays] = useState(7);
  const cmp = useLoad(() => api.getExpressComparison(token, days), [token, days]);
  const [form, setForm] = useState({ tier: "economy", source: "bolt", period: "day", distanceKm: "", durationMin: "", observedFareNaira: "", routeLabel: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [msg, setMsg] = useState(null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr(null); setMsg(null);
    try {
      const s = await api.logExpressSample(token, {
        ...form,
        distanceKm: Number(form.distanceKm),
        durationMin: Number(form.durationMin),
        observedFareNaira: Number(form.observedFareNaira),
      });
      setMsg(`Logged. We would have charged ${naira(s.ourFareNaira)} for the same trip.`);
      setForm((f) => ({ ...f, distanceKm: "", durationMin: "", observedFareNaira: "", routeLabel: "" }));
      await cmp.reload();
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <Note>
        Check the same trip in another app, then log what it showed. Verdicts use the median of at least 5 samples, so one odd
        price (a surge, a promo) cannot swing the answer. Automatic repricing reads the same data.
      </Note>
      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        {[1, 3, 7, 30].map((d) => (
          <button key={d} className={`btn ${days === d ? "primary" : "ghost"}`} onClick={() => setDays(d)}>{d === 1 ? "Today" : `${d} days`}</button>
        ))}
      </div>
      {cmp.error ? <div className="error-text">{cmp.error}</div> : null}
      <div className="table-wrap" style={{ marginBottom: 24 }}>
        <table>
          <thead><tr><th>Tier</th><th>Samples</th><th>Our price vs theirs</th><th>Verdict</th><th>Suggested move</th><th>By competitor</th></tr></thead>
          <tbody>
            {(cmp.data ? cmp.data.tiers : []).map((t) => {
              const v = VERDICTS[t.verdict] || VERDICTS.not_enough_data;
              return (
                <tr key={t.tier}>
                  <td style={{ textTransform: "capitalize", fontWeight: 600 }}>{t.tier}</td>
                  <td>{t.samples}</td>
                  <td>{t.medianRatio != null ? `${Math.round(t.medianRatio * 100)}%` : ""}</td>
                  <td><StatusPill label={v.label} tone={v.tone} /></td>
                  <td>{t.suggestedChangePct ? `${t.suggestedChangePct > 0 ? "+" : ""}${t.suggestedChangePct}%` : ""}</td>
                  <td style={{ fontSize: 12.5, color: "var(--text-muted)" }}>
                    {Object.entries(t.bySource || {}).map(([s, b]) => `${s}: ${b.samples} (${Math.round(b.medianRatio * 100)}%)`).join(", ")}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <h3 style={{ marginBottom: 10 }}>Log a competitor price</h3>
      <form className="table-wrap" style={{ padding: 18 }} onSubmit={submit}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
          <select className="field" value={form.tier} onChange={set("tier")}>{TIERS.map((t) => <option key={t}>{t}</option>)}</select>
          <select className="field" value={form.source} onChange={set("source")}>{SOURCES.map((t) => <option key={t}>{t}</option>)}</select>
          <select className="field" value={form.period} onChange={set("period")}><option value="day">Day</option><option value="night">Night</option></select>
          <input className="field" type="number" step="0.1" min="0" placeholder="Distance (km)" value={form.distanceKm} onChange={set("distanceKm")} required />
          <input className="field" type="number" step="1" min="0" placeholder="Duration (min)" value={form.durationMin} onChange={set("durationMin")} required />
          <input className="field" type="number" step="1" min="0" placeholder="Their fare (₦)" value={form.observedFareNaira} onChange={set("observedFareNaira")} required />
          <input className="field" placeholder="Route (optional)" value={form.routeLabel} onChange={set("routeLabel")} />
        </div>
        <button className="btn primary" disabled={busy} type="submit">{busy ? "Saving…" : "Log price"}</button>
        {err ? <div className="error-text" style={{ marginTop: 10 }}>{err}</div> : null}
        {msg ? <div style={{ marginTop: 10, color: "var(--teal)", fontSize: 13 }}>{msg}</div> : null}
      </form>
    </div>
  );
}

// ── Quests ───────────────────────────────────────────────────────────────
function QuestsTab({ token }) {
  const quests = useLoad(() => api.getExpressQuests(token), [token]);
  const blank = { title: "", tier: "", targetTrips: "10", rewardNaira: "5000", maxWinners: "50", endsAt: "", minDriverRating: "" };
  const [form, setForm] = useState(blank);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const worstCase = (Number(form.rewardNaira) || 0) * (Number(form.maxWinners) || 0);

  const create = async (e) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const body = {
        title: form.title,
        targetTrips: Number(form.targetTrips),
        rewardNaira: Number(form.rewardNaira),
        maxWinners: Number(form.maxWinners),
        endsAt: new Date(form.endsAt).toISOString(),
      };
      if (form.tier) body.tier = form.tier;
      if (form.minDriverRating) body.minDriverRating = Number(form.minDriverRating);
      await api.createExpressQuest(token, body);
      setForm(blank);
      await quests.reload();
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setBusy(false);
    }
  };

  const end = async (q) => {
    if (!window.confirm(`End "${q.title}"? Drivers keep any reward already earned.`)) return;
    try { await api.endExpressQuest(token, q.id); await quests.reload(); } catch (e) { setErr(e.message); }
  };

  const now = Date.now();
  const stateOf = (q) => (!q.isActive ? ["Ended", "muted"] : new Date(q.endsAt).getTime() < now ? ["Expired", "muted"] : new Date(q.startsAt).getTime() > now ? ["Scheduled", "amber"] : ["Running", "teal"]);

  return (
    <div>
      <Note>
        A quest pays a fixed reward for finishing a number of real trips in a window. The most it can ever cost is reward times
        winners, shown before you create it. Trips must be started, a minimum length, and limited per rider so they cannot be faked.
      </Note>
      <form className="table-wrap" style={{ padding: 18, marginBottom: 24 }} onSubmit={create}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
          <input className="field" placeholder="Title (for example: 20 trips this week)" value={form.title} onChange={set("title")} required />
          <select className="field" value={form.tier} onChange={set("tier")}><option value="">Any tier</option>{TIERS.map((t) => <option key={t}>{t}</option>)}</select>
          <input className="field" type="number" min="1" placeholder="Trips needed" value={form.targetTrips} onChange={set("targetTrips")} required />
          <input className="field" type="number" min="100" placeholder="Reward (₦)" value={form.rewardNaira} onChange={set("rewardNaira")} required />
          <input className="field" type="number" min="1" placeholder="Max winners" value={form.maxWinners} onChange={set("maxWinners")} required />
          <input className="field" type="datetime-local" value={form.endsAt} onChange={set("endsAt")} required />
          <input className="field" type="number" step="0.1" min="1" max="5" placeholder="Min rating (optional)" value={form.minDriverRating} onChange={set("minDriverRating")} />
        </div>
        <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
          <button className="btn primary" disabled={busy} type="submit">{busy ? "Creating…" : "Create quest"}</button>
          <span style={{ fontSize: 13, color: "var(--text-muted)" }}>Worst case cost: <strong style={{ color: "var(--text)" }}>{naira(worstCase)}</strong></span>
        </div>
        {err ? <div className="error-text" style={{ marginTop: 10 }}>{err}</div> : null}
      </form>

      {quests.error ? <div className="error-text">{quests.error}</div> : null}
      <div className="table-wrap">
        {quests.data && quests.data.quests && quests.data.quests.length ? (
          <table>
            <thead><tr><th>Quest</th><th>Status</th><th>Goal</th><th>Winners</th><th>Drivers in</th><th>Owed</th><th>Paid</th><th>Max cost</th><th>Ends</th><th></th></tr></thead>
            <tbody>
              {quests.data.quests.map((q) => {
                const [label, tone] = stateOf(q);
                return (
                  <tr key={q.id}>
                    <td><div style={{ fontWeight: 600 }}>{q.title}</div><div style={{ color: "var(--text-muted)", fontSize: 12 }}>{q.tier || "any tier"}</div></td>
                    <td><StatusPill label={label} tone={tone} /></td>
                    <td>{q.targetTrips} trips for {naira(q.rewardNaira)}</td>
                    <td>{q.winners} / {q.maxWinners}</td>
                    <td>{q.driversParticipating}</td>
                    <td>{naira(q.owedNaira)}</td><td>{naira(q.paidNaira)}</td><td>{naira(q.maxLiabilityNaira)}</td>
                    <td>{formatDateTime(q.endsAt)}</td>
                    <td>{q.isActive ? <button className="btn revoke" onClick={() => end(q)}>End</button> : null}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : <div className="empty-state">No quests yet.</div>}
      </div>
    </div>
  );
}

// ── Payouts ──────────────────────────────────────────────────────────────
function PayoutsTab({ token }) {
  const [status, setStatus] = useState("owed");
  const payouts = useLoad(() => api.getExpressPayouts(token, status), [token, status]);
  const [busyId, setBusyId] = useState(null);
  const [err, setErr] = useState(null);
  const [msg, setMsg] = useState(null);
  const rows = payouts.data ? payouts.data.payouts : [];
  const owedTotal = rows.filter((r) => r.status === "owed").reduce((n, r) => n + Number(r.rewardNaira), 0);

  const run = async (id, fn, okMsg) => {
    setBusyId(id); setErr(null); setMsg(null);
    try { const r = await fn(); setMsg(typeof okMsg === "function" ? okMsg(r) : okMsg); await payouts.reload(); }
    catch (e) { setErr(e.message); }
    finally { setBusyId(null); }
  };
  const payAll = () => {
    if (!window.confirm(`Credit ${rows.length} reward${rows.length === 1 ? "" : "s"} (${naira(owedTotal)}) to driver wallets now? This cannot be undone.`)) return;
    run("all", () => api.payAllExpressPayouts(token), (r) => `Credited ${r.paid} reward${r.paid === 1 ? "" : "s"}, ${naira(r.paidNaira)} in total.`);
  };

  return (
    <div>
      <Note>
        "Pay to wallet" credits the driver's RideArrivo wallet, once, with a ledger entry. "Mark paid" only records money you sent
        some other way. The daily limit on automatic payout does not apply to what you pay here.
      </Note>
      <div style={{ display: "flex", gap: 8, marginBottom: 14, alignItems: "center", flexWrap: "wrap" }}>
        <button className={`btn ${status === "owed" ? "primary" : "ghost"}`} onClick={() => setStatus("owed")}>Owed</button>
        <button className={`btn ${status === "paid" ? "primary" : "ghost"}`} onClick={() => setStatus("paid")}>Paid</button>
        {status === "owed" && rows.length ? (
          <button className="btn verify" style={{ marginLeft: "auto" }} disabled={busyId === "all"} onClick={payAll}>Pay all owed to wallets ({naira(owedTotal)})</button>
        ) : null}
      </div>
      {err ? <div className="error-text">{err}</div> : null}
      {msg ? <div style={{ marginBottom: 10, color: "var(--teal)", fontSize: 13 }}>{msg}</div> : null}
      {payouts.error ? <div className="error-text">{payouts.error}</div> : null}
      <div className="table-wrap">
        {rows.length ? (
          <table>
            <thead><tr><th>Driver</th><th>Quest</th><th>Reward</th><th>Earned</th><th>{status === "paid" ? "Paid" : ""}</th><th></th></tr></thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id}>
                  <td><div style={{ fontWeight: 600 }}>{p.driverName}</div><div style={{ color: "var(--text-muted)", fontSize: 12 }}>{p.driverPhone || ""}</div></td>
                  <td>{p.title}</td>
                  <td>{naira(p.rewardNaira)}</td>
                  <td>{formatDateTime(p.earnedAt)}</td>
                  <td>{p.status === "paid" ? <span style={{ fontSize: 12.5 }}>{formatDateTime(p.paidAt)} ({p.paidVia === "wallet" ? "wallet" : "outside the app"})</span> : null}</td>
                  <td style={{ display: "flex", gap: 8 }}>
                    {p.status === "owed" ? (
                      <>
                        <button className="btn verify" disabled={busyId === p.id} onClick={() => run(p.id, () => api.payExpressPayoutToWallet(token, p.id), "Credited to the driver's wallet.")}>Pay to wallet</button>
                        <button className="btn ghost" disabled={busyId === p.id} onClick={() => run(p.id, () => api.markExpressPayoutPaid(token, p.id), "Marked as paid.")}>Mark paid</button>
                      </>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <div className="empty-state">{status === "owed" ? "Nothing owed." : "No rewards paid yet."}</div>}
      </div>
    </div>
  );
}

// ── Automation ───────────────────────────────────────────────────────────
const SWITCH_COPY = {
  express_auto_payout_enabled: {
    title: "Automatic payout to driver wallets",
    body: "When a driver earns a quest reward it is credited to their wallet straight away, up to a daily limit. Past the limit rewards wait here for you.",
  },
  express_auto_reprice_enabled: {
    title: "Automatic repricing",
    body: "Once a day, nudges a tier's prices by at most a few percent when several competitors all say we are off. Needs logged competitor prices first.",
  },
};

const HOLD_REASONS = {
  cooldown: "Changed recently",
  not_enough_samples: "Not enough samples",
  not_enough_sources: "Needs 2 competitors",
  sources_disagree: "Competitors disagree",
  in_line: "In line with market",
  outside_band: "Would leave the allowed range",
  rounds_to_no_change: "Too small to change",
  publish_refused: "Refused by price checks",
};

function AutomationTab({ token }) {
  const info = useLoad(() => api.getExpressAutomation(token), [token]);
  const plan = useLoad(() => api.getExpressRepricePlan(token), [token]);
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState(null);
  const [msg, setMsg] = useState(null);

  const toggle = async (sw) => {
    const turningOn = sw.value !== "true";
    const copy = SWITCH_COPY[sw.key];
    if (turningOn && !window.confirm(`Turn ON: ${copy.title}?\n\n${copy.body}`)) return;
    setBusy(sw.key); setErr(null); setMsg(null);
    try { await api.setExpressAutomation(token, sw.key, turningOn); await info.reload(); }
    catch (e) { setErr(e.message); }
    finally { setBusy(null); }
  };

  const apply = async () => {
    if (!window.confirm("Apply the plan below now? Tiers marked Change will have new prices published immediately.")) return;
    setBusy("apply"); setErr(null); setMsg(null);
    try {
      const r = await api.applyExpressReprice(token);
      setMsg(r.ran ? `Applied ${r.applied.length} change${r.applied.length === 1 ? "" : "s"}.` : `Did not run: ${r.reason}.`);
      await Promise.all([info.reload(), plan.reload()]);
    } catch (e) { setErr(e.message); }
    finally { setBusy(null); }
  };

  const d = info.data;
  const changes = plan.data && plan.data.tiers ? plan.data.tiers.filter((t) => t.action === "change") : [];

  return (
    <div>
      <Note>Both switches are off until you turn them on. Every automatic action is logged below.</Note>
      {err ? <div className="error-text">{err}</div> : null}
      {msg ? <div style={{ marginBottom: 10, color: "var(--teal)", fontSize: 13 }}>{msg}</div> : null}
      {info.error ? <div className="error-text">{info.error}</div> : null}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 16, marginBottom: 28 }}>
        {(d ? d.switches : []).map((sw) => {
          const on = sw.value === "true";
          const copy = SWITCH_COPY[sw.key] || { title: sw.key, body: sw.description };
          return (
            <div key={sw.key} className="stat-card">
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
                <div style={{ fontWeight: 700 }}>{copy.title}</div>
                <StatusPill label={on ? "On" : "Off"} tone={on ? "teal" : "muted"} />
              </div>
              <p style={{ color: "var(--text-muted)", fontSize: 12.5, margin: "10px 0 14px" }}>{copy.body}</p>
              {sw.key === "express_auto_payout_enabled" && d ? (
                <p style={{ fontSize: 12.5, margin: "0 0 14px" }}>Paid automatically today: {naira(d.limits.payoutPaidTodayNaira)} of {naira(d.limits.payoutDailyCapNaira)}</p>
              ) : null}
              <button className={`btn ${on ? "revoke" : "primary"}`} disabled={busy === sw.key} onClick={() => toggle(sw)}>
                {on ? "Turn off" : "Turn on"}
              </button>
            </div>
          );
        })}
      </div>

      <h3 style={{ marginBottom: 6 }}>What repricing would do right now</h3>
      <Note>
        {d ? `Steps of at most ${d.limits.reprice.maxStepPct}%, at least ${d.limits.reprice.minSamples} samples from ${d.limits.reprice.minSources} competitors, ` +
          `one change per ${d.limits.reprice.cooldownHours} hours, staying within ${d.limits.reprice.bandMinPct}% to ${d.limits.reprice.bandMaxPct}% of the standard price.` : ""}
      </Note>
      <div className="table-wrap" style={{ marginBottom: 12 }}>
        <table>
          <thead><tr><th>Tier</th><th>Decision</th><th>Detail</th></tr></thead>
          <tbody>
            {(plan.data && plan.data.tiers ? plan.data.tiers : []).map((t) => (
              <tr key={t.tier}>
                <td style={{ textTransform: "capitalize", fontWeight: 600 }}>{t.tier}</td>
                <td>{t.action === "change" ? <StatusPill label={`Change ${t.changePct > 0 ? "+" : ""}${t.changePct}%`} tone="amber" /> : <StatusPill label="Hold" tone="muted" />}</td>
                <td style={{ fontSize: 12.5, color: "var(--text-muted)" }}>
                  {t.action === "change" ? `${t.samples} samples, our price is ${Math.round(t.medianRatio * 100)}% of theirs` : (HOLD_REASONS[t.reason] || t.reason)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button className="btn primary" disabled={busy === "apply" || !changes.length} onClick={apply}>Apply this plan now</button>

      <h3 style={{ margin: "28px 0 10px" }}>Recent automatic activity</h3>
      <div className="table-wrap">
        {d && d.log.length ? (
          <table>
            <thead><tr><th>When</th><th>What</th><th>Detail</th></tr></thead>
            <tbody>
              {d.log.map((l) => (
                <tr key={l.id}>
                  <td>{formatDateTime(l.createdAt)}</td>
                  <td style={{ textTransform: "capitalize" }}>{l.kind}: {String(l.action).replace(/_/g, " ")}</td>
                  <td style={{ fontSize: 12.5, color: "var(--text-muted)" }}>
                    {l.kind === "payout" && l.detail.rewardNaira ? `${naira(l.detail.rewardNaira)} to driver #${l.detail.driverId}` : ""}
                    {l.kind === "payout" && l.action === "cap_reached" ? `Daily limit ${naira(l.detail.capNaira)} reached, ${l.detail.heldPayouts} reward(s) waiting` : ""}
                    {l.kind === "reprice" && l.detail.applied ? `${l.detail.applied.length} changed, ${l.detail.held.length} held` : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <div className="empty-state">Nothing automatic has happened yet.</div>}
      </div>
    </div>
  );
}

export function ExpressPricingPage() {
  const { token, user } = useAuth();
  const [tab, setTab] = useState("prices");
  // The API refuses everyone but admins; say so plainly instead of showing
  // five tabs of errors.
  if (user && user.role !== "admin") {
    return <div className="empty-state">ArrivoExpress pricing, quests and automation are for administrators only.</div>;
  }
  return (
    <div>
      <div className="page-header">
        <div>
          <span className="eyebrow">ArrivoExpress</span>
          <h1>Pricing, quests and automation</h1>
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, marginBottom: 20, flexWrap: "wrap" }}>
        {TABS.map((t) => (
          <button key={t.id} className={`btn ${tab === t.id ? "primary" : "ghost"}`} onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </div>
      {tab === "prices" ? <PricesTab token={token} /> : null}
      {tab === "market" ? <MarketTab token={token} /> : null}
      {tab === "quests" ? <QuestsTab token={token} /> : null}
      {tab === "payouts" ? <PayoutsTab token={token} /> : null}
      {tab === "automation" ? <AutomationTab token={token} /> : null}
    </div>
  );
}
