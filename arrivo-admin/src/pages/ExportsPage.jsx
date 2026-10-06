import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../AuthContext";
import * as api from "../api";

// Calendar days in Lagos, as YYYY-MM-DD. The server reads the dates the same
// way, so "today" here and "today" in the file always agree.
function lagosToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos" }).format(new Date());
}

function shiftDays(day, delta) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function monthStart(day, monthsBack = 0) {
  const [y, m] = day.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 - monthsBack, 1, 12));
  return d.toISOString().slice(0, 10);
}

function monthEnd(day, monthsBack = 0) {
  const [y, m] = day.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - monthsBack, 0, 12));
  return d.toISOString().slice(0, 10);
}

const PRESETS = [
  { label: "All time", range: () => ({ from: "", to: "" }) },
  { label: "Last 7 days", range: (t) => ({ from: shiftDays(t, -6), to: t }) },
  { label: "Last 30 days", range: (t) => ({ from: shiftDays(t, -29), to: t }) },
  { label: "This month", range: (t) => ({ from: monthStart(t), to: t }) },
  { label: "Last month", range: (t) => ({ from: monthStart(t, 1), to: monthEnd(t, 1) }) },
];

const STATUS_LABELS = {
  started: "Started",
  completed: "Completed",
  failed: "Failed",
  aborted: "Cancelled",
};

export function ExportsPage() {
  const { token, user } = useAuth();
  const isAdmin = user?.role === "admin";

  const [datasets, setDatasets] = useState([]);
  const [maxRows, setMaxRows] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  // Per-dataset state, keyed by dataset: { busy, message, failed }
  const [state, setState] = useState({});
  const [history, setHistory] = useState([]);

  const loadHistory = useCallback(async () => {
    if (!isAdmin) return;
    try {
      const { history } = await api.getExportHistory(token);
      setHistory(history);
    } catch {
      // The log is a convenience. A failure here must not hide the downloads.
    }
  }, [token, isAdmin]);

  useEffect(() => {
    let cancelled = false;
    api.getExportList(token)
      .then(({ datasets, maxRows }) => {
        if (cancelled) return;
        setDatasets(datasets);
        setMaxRows(maxRows);
        setError(null);
      })
      .catch((e) => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    loadHistory();
    return () => { cancelled = true; };
  }, [token, loadHistory]);

  const rangeInvalid = Boolean(from && to && from > to);

  async function download(dataset) {
    setState((s) => ({ ...s, [dataset.key]: { busy: true } }));
    try {
      const { filename, rows } = await api.downloadExport(token, dataset.key, { from, to });
      setState((s) => ({
        ...s,
        [dataset.key]: { message: `Downloaded ${rows === null ? "" : `${rows.toLocaleString()} ${rows === 1 ? "row" : "rows"} to `}${filename}` },
      }));
    } catch (e) {
      setState((s) => ({ ...s, [dataset.key]: { message: e.message, failed: true } }));
    } finally {
      loadHistory();
    }
  }

  const today = lagosToday();

  return (
    <div>
      <div className="page-header">
        <div>
          <span className="eyebrow">Proof of operations</span>
          <h1>Exports</h1>
        </div>
      </div>

      <div className="stat-card" style={{ marginBottom: 20, fontSize: 13, lineHeight: 1.55 }}>
        Download operational records as CSV files that open in Excel or Google Sheets. Times are Lagos time.
        The files contain personal details, so keep them somewhere secure and share them only with people who need them.
        <strong> Every download is recorded</strong> with who took it, what it was and when.
      </div>

      <div className="stat-card" style={{ marginBottom: 24 }}>
        <div style={{ fontWeight: 600, marginBottom: 10 }}>Date range</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
          {PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              className="btn ghost"
              onClick={() => {
                const r = p.range(today);
                setFrom(r.from);
                setTo(r.to);
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
          <label style={{ fontSize: 12.5, color: "var(--text-muted)" }}>
            From{" "}
            <input type="date" className="field" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label style={{ fontSize: 12.5, color: "var(--text-muted)" }}>
            To{" "}
            <input type="date" className="field" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
          </label>
          <span style={{ fontSize: 12.5, color: "var(--text-muted)" }}>
            {from || to ? `Records dated ${from || "the beginning"} to ${to || "today"}` : "All records"}
          </span>
        </div>
        {rangeInvalid ? <div className="error-text" style={{ marginTop: 10 }}>The From date cannot be after the To date.</div> : null}
        {maxRows ? (
          <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 10 }}>
            One file holds up to {maxRows.toLocaleString()} rows. If a download is too large, choose a shorter range.
          </div>
        ) : null}
      </div>

      {error ? <div className="error-text">{error}</div> : null}

      {loading ? (
        <div className="empty-state">Loading exports…</div>
      ) : (
        <div className="stat-grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))" }}>
          {datasets.map((d) => {
            const s = state[d.key] || {};
            return (
              <div className="stat-card" key={d.key} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={{ fontWeight: 600 }}>
                  {d.label}
                  {d.adminOnly ? <span style={{ marginLeft: 8, fontSize: 10.5, color: "var(--amber)", letterSpacing: "0.06em" }}>ADMIN ONLY</span> : null}
                </div>
                <div style={{ fontSize: 12.5, color: "var(--text-muted)", lineHeight: 1.5, flex: 1 }}>{d.description}</div>
                <div>
                  <button
                    type="button"
                    className="btn primary"
                    disabled={s.busy || rangeInvalid}
                    onClick={() => download(d)}
                  >
                    {s.busy ? "Preparing…" : "Download CSV"}
                  </button>
                </div>
                {s.message ? (
                  <div role="status" style={{ fontSize: 12, color: s.failed ? "var(--coral)" : "var(--teal)" }}>{s.message}</div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      {isAdmin ? (
        <div style={{ marginTop: 32 }}>
          <h2 style={{ fontSize: 16, marginBottom: 12 }}>Download history</h2>
          <div className="table-wrap">
            {history.length === 0 ? (
              <div className="empty-state">No downloads recorded yet.</div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>When (Lagos)</th>
                    <th>Who</th>
                    <th>Export</th>
                    <th>Range</th>
                    <th>Rows</th>
                    <th>Result</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((h) => (
                    <tr key={h.id}>
                      <td style={{ fontSize: 12.5 }}>{h.time_wat}</td>
                      <td>
                        <div>{h.user_email}</div>
                        <div style={{ color: "var(--text-muted)", fontSize: 12 }}>{h.user_role}{h.source === "workspace" ? " · Workspace" : ""}</div>
                      </td>
                      <td>{h.dataset}</td>
                      <td style={{ color: "var(--text-muted)", fontSize: 12.5 }}>
                        {h.date_from || h.date_to ? `${String(h.date_from || "").slice(0, 10) || "start"} to ${String(h.date_to || "").slice(0, 10) || "now"}` : "All time"}
                      </td>
                      <td>{h.row_count ?? "-"}</td>
                      <td style={{ color: h.status === "completed" ? "var(--teal)" : "var(--coral)", fontSize: 12.5 }}>{STATUS_LABELS[h.status] || h.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
