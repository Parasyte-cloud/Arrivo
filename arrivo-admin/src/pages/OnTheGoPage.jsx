import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../AuthContext";
import * as api from "../api";
import { formatDateTime } from "../utils";
import { PhoneLink } from "../components/PhoneLink";
import { StatusPill } from "../components/StatusPill";

// The queue for On the Go requests: riders who need a car within about 12
// hours, or who tried a standard booking that was too close. These are all
// time-critical, so pending ones come first (oldest first, the API's order)
// and the page refreshes itself. Ops rings the contact number, then marks the
// request confirmed or cancelled. Only admins can change a status, the same
// rule as the other mutating admin actions, so support and operations accounts
// see why there is no button instead of one that would fail.

const STATUS_TONE = { pending: "amber", confirmed: "teal", cancelled: "coral" };

// The time the rider asked for is a Lagos clock time, shown as one whatever
// zone this browser is in.
function formatLagos(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const text = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Lagos",
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
  return `${text} (Lagos time)`;
}

export function OnTheGoPage() {
  const { token, isReadOnly } = useAuth();
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    try {
      const { requests } = await api.getOnTheGo(token);
      setRequests(requests);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    load();
    const interval = setInterval(load, 15000);
    return () => clearInterval(interval);
  }, [load]);

  async function setStatus(id, status) {
    setBusyId(id);
    setError(null);
    try {
      const { request } = await api.setOnTheGoStatus(token, id, status);
      // Keep the joined rider fields; the PATCH response is the bare row.
      setRequests((list) => list.map((r) => (r.id === id ? { ...r, ...request } : r)));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusyId(null);
    }
  }

  const pending = requests.filter((r) => r.status === "pending").length;

  return (
    <div>
      <div className="page-header">
        <div>
          <span className="eyebrow">Needs attention</span>
          <h1>On the Go{pending ? ` (${pending} waiting)` : ""}</h1>
        </div>
      </div>

      {error ? <div className="error-text">{error}</div> : null}

      {loading ? (
        <div className="empty-state">Loading...</div>
      ) : requests.length === 0 ? (
        <div className="table-wrap">
          <div className="empty-state">No On the Go requests yet.</div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {requests.map((r) => {
            const wanted = formatLagos(r.requested_pickup_at);
            const isPending = r.status === "pending";
            return (
              <div key={r.id} className={`alert-card${isPending ? " warning" : ""}`}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <StatusPill label={r.status} tone={STATUS_TONE[r.status] || "muted"} />
                      {r.source_service ? <StatusPill label={r.source_service} tone="muted" /> : null}
                      <span style={{ color: "var(--text-muted)", fontSize: 12.5 }}>
                        #{r.id} · sent {formatDateTime(r.created_at)}
                      </span>
                    </div>
                    <div style={{ fontWeight: 700, fontSize: 15, marginTop: 8, color: wanted ? "var(--coral)" : undefined }}>
                      {wanted ? `Wants the car: ${wanted}` : "Wants the car: as soon as possible"}
                    </div>
                  </div>

                  {isReadOnly ? (
                    <span style={{ color: "var(--text-muted)", fontSize: 12.5 }}>Admin only</span>
                  ) : (
                    <div style={{ display: "flex", gap: 8 }}>
                      {isPending ? (
                        <>
                          <button type="button" className="btn" disabled={busyId === r.id} onClick={() => setStatus(r.id, "confirmed")}>
                            Mark confirmed
                          </button>
                          <button type="button" className="btn ghost" disabled={busyId === r.id} onClick={() => setStatus(r.id, "cancelled")}>
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button type="button" className="btn ghost" disabled={busyId === r.id} onClick={() => setStatus(r.id, "pending")}>
                          Reopen
                        </button>
                      )}
                    </div>
                  )}
                </div>

                <div className="detail-grid" style={{ marginBottom: 12, fontSize: 13.5 }}>
                  <div>
                    <div style={{ color: "var(--text-muted)", fontSize: 11.5, marginBottom: 2 }}>RING</div>
                    <div style={{ fontWeight: 600 }}><PhoneLink phone={r.contact_phone} /></div>
                    <div>{r.user_name || ""}</div>
                    <div style={{ color: "var(--text-muted)" }}>{r.user_email || ""}</div>
                  </div>
                  <div>
                    <div style={{ color: "var(--text-muted)", fontSize: 11.5, marginBottom: 2 }}>TRIP</div>
                    <div>From: {r.pickup_address}</div>
                    <div>To: {r.destination_address}</div>
                    <div style={{ color: "var(--text-muted)" }}>
                      {r.passenger_count} {r.passenger_count === 1 ? "passenger" : "passengers"}
                      {r.flight_number ? ` · flight ${r.flight_number}` : ""}
                    </div>
                  </div>
                </div>

                {r.details ? (
                  <div style={{ whiteSpace: "pre-wrap", fontSize: 13.5 }}>
                    <span style={{ color: "var(--text-muted)", fontSize: 11.5 }}>DETAILS </span>
                    {r.details}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
