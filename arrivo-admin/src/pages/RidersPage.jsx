import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../AuthContext";
import * as api from "../api";
import { StatusPill } from "../components/StatusPill";

export function RidersPage() {
  const { token } = useAuth();
  const [riders, setRiders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

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

  return (
    <div>
      <div className="page-header">
        <div>
          <span className="eyebrow">Rider accounts</span>
          <h1>Riders</h1>
        </div>
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

      {error ? <div className="error-text">{error}</div> : null}

      <div className="table-wrap">
        {loading ? (
          <div className="empty-state">Loading riders…</div>
        ) : riders.length === 0 ? (
          <div className="empty-state">No riders have signed up yet.</div>
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
              {riders.map((r) => (
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
