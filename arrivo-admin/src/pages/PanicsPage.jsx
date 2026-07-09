import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../AuthContext";
import * as api from "../api";

export function PanicsPage() {
  const { token } = useAuth();
  const [panics, setPanics] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [resolvingId, setResolvingId] = useState(null);
  const [noteDrafts, setNoteDrafts] = useState({});

  const load = useCallback(async () => {
    try {
      const { panics } = await api.getPanics(token);
      setPanics(panics);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    load();
    // Panic alerts are time-critical — poll far more aggressively than any
    // other admin view. 10 seconds is a deliberate choice: frequent enough
    // that ops sees a new alert almost immediately, not so frequent it
    // hammers the server.
    const interval = setInterval(load, 10000);
    return () => clearInterval(interval);
  }, [load]);

  const resolve = async (rideId) => {
    setResolvingId(rideId);
    try {
      await api.resolvePanic(token, rideId, noteDrafts[rideId] || "");
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setResolvingId(null);
    }
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <span className="eyebrow" style={{ color: "var(--coral)" }}>Safety</span>
          <h1>Panic Alerts</h1>
        </div>
      </div>

      {error ? <div className="error-text">{error}</div> : null}

      {loading ? (
        <div className="empty-state">Loading…</div>
      ) : panics.length === 0 ? (
        <div className="table-wrap">
          <div className="empty-state">No active safety alerts right now.</div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {panics.map((p) => (
            <div
              key={p.id}
              style={{
                background: "#fff",
                border: "2px solid var(--coral)",
                borderRadius: "var(--radius)",
                padding: 20,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 15, color: "var(--coral)" }}>
                    🚨 Ride #{p.id} — triggered {new Date(p.panic_triggered_at).toLocaleString()}
                  </div>
                  <div style={{ fontSize: 12.5, color: "var(--text-muted)", marginTop: 4 }}>
                    {Math.round((Date.now() - new Date(p.panic_triggered_at)) / 60000)} minutes ago
                  </div>
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 14, fontSize: 13.5 }}>
                <div>
                  <div style={{ color: "var(--text-muted)", fontSize: 11.5, marginBottom: 2 }}>RIDER</div>
                  <div style={{ fontWeight: 600 }}>{p.rider_name}</div>
                  <div>{p.rider_phone || "No phone on file"}</div>
                  <div style={{ color: "var(--text-muted)" }}>{p.rider_email}</div>
                </div>
                <div>
                  <div style={{ color: "var(--text-muted)", fontSize: 11.5, marginBottom: 2 }}>DRIVER</div>
                  <div style={{ fontWeight: 600 }}>{p.driver_name || "Unassigned"}</div>
                  <div>{p.driver_phone || "—"}</div>
                  {p.current_lat && p.current_lng ? (
                    <a
                      href={`https://www.google.com/maps?q=${p.current_lat},${p.current_lng}`}
                      target="_blank"
                      rel="noreferrer"
                      style={{ color: "var(--teal)", fontWeight: 600 }}
                    >
                      View last known location →
                    </a>
                  ) : (
                    <div style={{ color: "var(--text-muted)" }}>No location on file</div>
                  )}
                </div>
              </div>

              <div style={{ marginBottom: 12, fontSize: 13 }}>
                <div style={{ color: "var(--text-muted)", fontSize: 11.5, marginBottom: 2 }}>PICKUP</div>
                {p.pickup_address}
              </div>

              {p.panic_notes ? (
                <div style={{ background: "#FDEAE7", borderRadius: 8, padding: 10, fontSize: 12.5, marginBottom: 12 }}>
                  <strong>Rider's note:</strong> {p.panic_notes}
                </div>
              ) : null}

              <textarea
                className="notes"
                placeholder="Resolution notes — e.g. 'Called rider, confirmed safe, driver took valid detour'"
                value={noteDrafts[p.id] || ""}
                onChange={(e) => setNoteDrafts((prev) => ({ ...prev, [p.id]: e.target.value }))}
              />
              <div style={{ marginTop: 10 }}>
                <button className="btn verify" disabled={resolvingId === p.id} onClick={() => resolve(p.id)}>
                  {resolvingId === p.id ? "Resolving…" : "Mark as resolved"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
