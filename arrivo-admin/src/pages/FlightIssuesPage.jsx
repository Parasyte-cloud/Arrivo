import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../AuthContext";
import * as api from "../api";
import { formatDateTime } from "../utils";
import { PhoneLink } from "../components/PhoneLink";

// A "needs attention" queue, same shape as PanicsPage, for rides the
// scheduler (services/scheduler.js) has flagged with a real flight
// cancellation or reschedule. There's no explicit "resolve" action here —
// unlike a panic, a flight issue doesn't get manually cleared; a ride drops
// off this list on its own once it's completed or cancelled (see
// routes/admin.js GET /flight-issues). This is read-only visibility so ops
// can proactively check on a rider instead of waiting for them to call in.
export function FlightIssuesPage() {
  const { token } = useAuth();
  const [flightIssues, setFlightIssues] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const { flightIssues } = await api.getFlightIssues(token);
      setFlightIssues(flightIssues);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    load();
    // Not as time-critical as panics, but still worth refreshing often
    // enough that ops sees a new issue without a manual reload.
    const interval = setInterval(load, 30000);
    return () => clearInterval(interval);
  }, [load]);

  return (
    <div>
      <div className="page-header">
        <div>
          <span className="eyebrow">Needs attention</span>
          <h1>Flight Issues</h1>
        </div>
      </div>

      {error ? <div className="error-text">{error}</div> : null}

      {loading ? (
        <div className="empty-state">Loading…</div>
      ) : flightIssues.length === 0 ? (
        <div className="table-wrap">
          <div className="empty-state">No open flight cancellations or reschedules right now.</div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {flightIssues.map((f) => (
            <div
              key={f.id}
              style={{
                background: "#fff",
                border: "2px solid var(--amber)",
                borderRadius: "var(--radius)",
                padding: 20,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 15, color: "var(--amber)" }}>
                    ✈️ Ride #{f.id} — flight {f.flight_issue === "cancelled" ? "cancelled" : "rescheduled"}
                    {f.flight_number ? ` (${f.flight_number})` : ""}
                  </div>
                  <div style={{ fontSize: 12.5, color: "var(--text-muted)", marginTop: 4 }}>
                    {f.flight_issue_notified_at ? `Flagged ${formatDateTime(f.flight_issue_notified_at)}` : "Flagged time unknown"}
                  </div>
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 14, fontSize: 13.5 }}>
                <div>
                  <div style={{ color: "var(--text-muted)", fontSize: 11.5, marginBottom: 2 }}>RIDER</div>
                  <div style={{ fontWeight: 600 }}>{f.rider_name}</div>
                  <div>{f.rider_phone ? <PhoneLink phone={f.rider_phone} /> : "No phone on file"}</div>
                  <div style={{ color: "var(--text-muted)" }}>{f.rider_email}</div>
                </div>
                <div>
                  <div style={{ color: "var(--text-muted)", fontSize: 11.5, marginBottom: 2 }}>DRIVER</div>
                  <div style={{ fontWeight: 600 }}>{f.driver_name || "Unassigned"}</div>
                  <div>{f.driver_phone ? <PhoneLink phone={f.driver_phone} /> : "—"}</div>
                </div>
              </div>

              <div style={{ marginBottom: 4, fontSize: 13 }}>
                <div style={{ color: "var(--text-muted)", fontSize: 11.5, marginBottom: 2 }}>PICKUP</div>
                {f.pickup_address}
              </div>
              {f.original_flight_scheduled_at ? (
                <div style={{ fontSize: 12.5, color: "var(--text-muted)", marginTop: 8 }}>
                  Original scheduled arrival: {formatDateTime(f.original_flight_scheduled_at)}
                </div>
              ) : null}
              <div style={{ fontSize: 12.5, color: "var(--text-muted)", marginTop: 4 }}>
                Ride status: {f.ride_status.replace("_", " ")}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
