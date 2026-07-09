import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../AuthContext";
import * as api from "../api";
import { StatusPill } from "../components/StatusPill";

export function RidersPage() {
  const { token } = useAuth();
  const [riders, setRiders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all"); // 'all' | 'never_booked' | 'booked'

  const load = useCallback(async () => {
    try {
      const { riders } = await api.getRiders(token);
      setRiders(riders);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const neverBooked = riders.filter((r) => r.ride_count === 0).length;

  const filtered = riders.filter((r) => {
    if (filter === "never_booked" && r.ride_count !== 0) return false;
    if (filter === "booked" && r.ride_count === 0) return false;
    if (search) {
      const q = search.toLowerCase();
      return r.name.toLowerCase().includes(q) || r.email.toLowerCase().includes(q) || (r.phone || "").includes(q);
    }
    return true;
  });

  return (
    <div>
      <div className="page-header">
        <div>
          <span className="eyebrow">Rider accounts</span>
          <h1>Riders</h1>
        </div>
        <button className="btn ghost" onClick={() => exportWaitlistCsv(token)}>Export Waitlist CSV</button>
      </div>

      <div className="stat-grid" style={{ marginBottom: 24 }}>
        <div className="stat-card">
          <div className="stat-num">{riders.length}</div>
          <div className="stat-label">Total signups</div>
        </div>
        <div className="stat-card">
          <div className="stat-num" style={{ color: "var(--coral)" }}>{neverBooked}</div>
          <div className="stat-label">Signed up, never booked</div>
        </div>
        <div className="stat-card">
          <div className="stat-num" style={{ color: "var(--teal)" }}>{riders.length - neverBooked}</div>
          <div className="stat-label">Booked at least once</div>
        </div>
      </div>

      <div style={{ display: "flex", gap: 10, marginBottom: 20, flexWrap: "wrap" }}>
        <input
          type="text"
          placeholder="Search name, email, or phone…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="field"
          style={{ flex: 1, minWidth: 220, maxWidth: 320 }}
        />
        <button className={`btn ${filter === "all" ? "primary" : "ghost"}`} onClick={() => setFilter("all")}>All</button>
        <button className={`btn ${filter === "never_booked" ? "primary" : "ghost"}`} onClick={() => setFilter("never_booked")}>Never booked</button>
        <button className={`btn ${filter === "booked" ? "primary" : "ghost"}`} onClick={() => setFilter("booked")}>Booked</button>
      </div>

      {error ? <div className="error-text">{error}</div> : null}

      <div className="table-wrap">
        {loading ? (
          <div className="empty-state">Loading riders…</div>
        ) : filtered.length === 0 ? (
          <div className="empty-state">{riders.length === 0 ? "No riders have signed up yet." : "No riders match your search."}</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Rider</th>
                <th>Signed up</th>
                <th>Rides</th>
                <th>Total spent</th>
                <th>Last activity</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.id}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{r.name}</div>
                    <div style={{ color: "var(--text-muted)", fontSize: 12 }}>{r.email}{r.phone ? ` · ${r.phone}` : ""}</div>
                  </td>
                  <td style={{ color: "var(--text-muted)", fontSize: 12.5 }}>
                    {new Date(r.created_at).toLocaleDateString()}
                  </td>
                  <td>
                    {r.ride_count === 0 ? (
                      <StatusPill label="Never booked" tone="coral" />
                    ) : (
                      <StatusPill label={`${r.ride_count} ride${r.ride_count > 1 ? "s" : ""}`} tone="teal" />
                    )}
                  </td>
                  <td>₦{r.total_spent_naira.toLocaleString()}</td>
                  <td style={{ color: "var(--text-muted)", fontSize: 12.5 }}>
                    {r.last_ride_at ? new Date(r.last_ride_at).toLocaleDateString() : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function exportWaitlistCsv(token) {
  api.getWaitlist(token).then(({ waitlist }) => {
    const header = "email,source,signed_up_at\n";
    const rows = waitlist.map((w) => `${w.email},${w.source || ""},${w.created_at}`).join("\n");
    const blob = new Blob([header + rows], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `arrivo-waitlist-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  });
}
