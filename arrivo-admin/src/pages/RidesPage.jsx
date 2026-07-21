import React, { useCallback, useEffect, useState } from "react";
import { useAuth } from "../AuthContext";
import * as api from "../api";
import { StatusPill, rideStatusTone } from "../components/StatusPill";
import { formatDateTime, downloadCsv } from "../utils";

const STATUS_FILTERS = [
  { id: "", label: "All" },
  { id: "requested", label: "Requested" },
  { id: "accepted", label: "Accepted" },
  { id: "in_progress", label: "In progress" },
  { id: "completed", label: "Completed" },
  { id: "cancelled", label: "Cancelled" },
];

// Debounces the search box so every keystroke doesn't fire its own request —
// the date/status filters below are discrete clicks so they don't need this.
function useDebounced(value, delayMs) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

function exportRidesCsv(rides) {
  downloadCsv(
    `arrivo-rides-${new Date().toISOString().slice(0, 10)}.csv`,
    rides,
    [
      { label: "Ride ID", value: (r) => r.id },
      { label: "Rider", value: (r) => r.rider_name },
      { label: "Rider email", value: (r) => r.rider_email },
      { label: "Rider phone", value: (r) => r.rider_phone || "" },
      { label: "Pickup", value: (r) => r.pickup_address },
      { label: "Flight number", value: (r) => r.flight_number || "" },
      { label: "Driver", value: (r) => r.driver_name || "" },
      { label: "Vehicle type", value: (r) => r.vehicle_type },
      { label: "Fare (NGN)", value: (r) => r.fare_naira },
      { label: "Payment status", value: (r) => r.payment_status },
      { label: "Ride status", value: (r) => r.ride_status },
      { label: "Created at", value: (r) => r.created_at },
    ]
  );
}

export function RidesPage() {
  const { token, isReadOnly } = useAuth();
  const [rides, setRides] = useState([]);
  const [filter, setFilter] = useState("");
  const [search, setSearch] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [saving, setSaving] = useState(false);

  const debouncedSearch = useDebounced(search, 350);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { rides } = await api.getRides(token, {
        status: filter || undefined,
        search: debouncedSearch || undefined,
        from: fromDate || undefined,
        to: toDate || undefined,
      });
      setRides(rides);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [token, filter, debouncedSearch, fromDate, toDate]);

  useEffect(() => { load(); }, [load]);

  const openRow = (ride) => {
    if (expandedId === ride.id) {
      setExpandedId(null);
    } else {
      setExpandedId(ride.id);
      setNoteDraft(ride.admin_notes || "");
    }
  };

  const saveNote = async (ride) => {
    setSaving(true);
    try {
      await api.updateRide(token, ride.id, { adminNotes: noteDraft });
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const forceCancel = async (ride) => {
    setSaving(true);
    try {
      await api.updateRide(token, ride.id, { rideStatus: "cancelled", adminNotes: noteDraft || ride.admin_notes });
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <span className="eyebrow">Fleet oversight</span>
          <h1>Rides</h1>
        </div>
        <button className="btn ghost" onClick={() => exportRidesCsv(rides)}>Export CSV</button>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.id}
            className={`btn ${filter === f.id ? "primary" : "ghost"}`}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div style={{ display: "flex", gap: 10, marginBottom: 20, flexWrap: "wrap", alignItems: "center" }}>
        <input
          type="text"
          placeholder="Search rider, driver, phone, or pickup address…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="field"
          style={{ flex: 1, minWidth: 240, maxWidth: 340 }}
        />
        <label style={{ fontSize: 12.5, color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 6 }}>
          From
          <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="field" />
        </label>
        <label style={{ fontSize: 12.5, color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 6 }}>
          To
          <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="field" />
        </label>
        {(search || fromDate || toDate) ? (
          <button className="btn ghost" onClick={() => { setSearch(""); setFromDate(""); setToDate(""); }}>
            Clear
          </button>
        ) : null}
      </div>

      {error ? <div className="error-text">{error}</div> : null}

      <div className="table-wrap">
        {loading ? (
          <div className="empty-state">Loading rides…</div>
        ) : rides.length === 0 ? (
          <div className="empty-state">No rides match this filter.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Rider</th>
                <th>Pickup</th>
                <th>Driver</th>
                <th>Fare</th>
                <th>Payment</th>
                <th>Status</th>
                <th>Live</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {rides.map((r) => (
                <React.Fragment key={r.id}>
                  <tr onClick={() => openRow(r)} style={{ cursor: "pointer" }}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{r.rider_name}</div>
                      <div style={{ color: "var(--text-muted)", fontSize: 12 }}>{r.rider_email}</div>
                    </td>
                    <td>
                      <div>{r.pickup_address}</div>
                      {r.flight_number ? <div style={{ color: "var(--text-muted)", fontSize: 12 }}>Flight {r.flight_number}</div> : null}
                    </td>
                    <td>{r.driver_name || <span style={{ color: "var(--text-muted)" }}>Unassigned</span>}</td>
                    <td>₦{r.fare_naira?.toLocaleString()}</td>
                    <td><StatusPill label={r.payment_status} tone={r.payment_status === "paid" ? "teal" : "muted"} /></td>
                    <td><StatusPill label={r.ride_status.replace("_", " ")} tone={rideStatusTone(r.ride_status)} /></td>
                    <td onClick={(e) => e.stopPropagation()}>
                      {r.ride_status === "in_progress" && r.current_lat && r.current_lng ? (
                        <a
                          href={`https://www.google.com/maps?q=${r.current_lat},${r.current_lng}`}
                          target="_blank"
                          rel="noreferrer"
                          style={{ color: "var(--teal)", fontWeight: 600, fontSize: 12.5 }}
                        >
                          📍 Track live
                        </a>
                      ) : (
                        <span style={{ color: "var(--text-muted)", fontSize: 12.5 }}>—</span>
                      )}
                    </td>
                    <td style={{ color: "var(--text-muted)", fontSize: 12 }}>{formatDateTime(r.created_at)}</td>
                  </tr>
                  {expandedId === r.id ? (
                    <tr>
                      <td colSpan={8} style={{ background: "#fafafd" }}>
                        <div style={{ padding: "8px 4px" }}>
                          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", marginBottom: 6, textTransform: "uppercase" }}>
                            Admin notes / dispute log
                          </div>
                          <textarea
                            className="notes"
                            value={noteDraft}
                            onChange={(e) => setNoteDraft(e.target.value)}
                            placeholder="e.g. Rider disputed the fare, refunded ₦2,000 via Paystack manually"
                            disabled={isReadOnly}
                            readOnly={isReadOnly}
                          />
                          {isReadOnly ? (
                            <p style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 8, fontStyle: "italic" }}>
                              Support view is read-only. Ask an admin to add notes or cancel this ride.
                            </p>
                          ) : (
                            <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                              <button className="btn primary" disabled={saving} onClick={() => saveNote(r)}>
                                {saving ? "Saving…" : "Save note"}
                              </button>
                              {r.ride_status !== "cancelled" && r.ride_status !== "completed" ? (
                                <button className="btn revoke" disabled={saving} onClick={() => forceCancel(r)}>
                                  Force-cancel ride
                                </button>
                              ) : null}
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  ) : null}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
