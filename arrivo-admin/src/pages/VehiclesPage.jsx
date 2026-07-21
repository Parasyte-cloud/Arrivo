import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../AuthContext";
import * as api from "../api";
import { StatusPill } from "../components/StatusPill";
import { formatDateTime } from "../utils";
import { PhoneLink } from "../components/PhoneLink";

// Every vehicle listed via routes/owners.js POST /vehicles, regardless of
// whether it's ever been picked up by a driver. Before this page existed,
// a vehicle only showed up in the admin panel once a verified driver was
// attached to it (via the Drivers page join) — an owner's listing sat
// invisible in the database until that happened, with no way for ops to
// even see it existed, let alone follow up.
export function VehiclesPage() {
  const { token } = useAuth();
  const [vehicles, setVehicles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    try {
      const { vehicles } = await api.getVehicles(token);
      setVehicles(vehicles);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const unassignedCount = vehicles.filter((v) => !v.assigned_driver_name).length;

  const filtered = vehicles.filter((v) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      v.owner_name.toLowerCase().includes(q) ||
      v.owner_email.toLowerCase().includes(q) ||
      v.make_model.toLowerCase().includes(q) ||
      v.plate_number.toLowerCase().includes(q)
    );
  });

  return (
    <div>
      <div className="page-header">
        <div>
          <span className="eyebrow">Fleet supply</span>
          <h1>Vehicles</h1>
        </div>
      </div>

      <div className="stat-grid" style={{ marginBottom: 24 }}>
        <div className="stat-card">
          <div className="stat-num">{vehicles.length}</div>
          <div className="stat-label">Vehicles listed</div>
        </div>
        <div className="stat-card">
          <div className="stat-num" style={{ color: "var(--coral)" }}>{unassignedCount}</div>
          <div className="stat-label">Not yet assigned to a driver</div>
        </div>
        <div className="stat-card">
          <div className="stat-num" style={{ color: "var(--teal)" }}>{vehicles.length - unassignedCount}</div>
          <div className="stat-label">In active use</div>
        </div>
      </div>

      <input
        type="text"
        placeholder="Search owner, email, make/model, or plate…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="field"
        style={{ marginBottom: 20, minWidth: 220, maxWidth: 320 }}
      />

      {error ? <div className="error-text">{error}</div> : null}

      <div className="table-wrap">
        {loading ? (
          <div className="empty-state">Loading vehicles…</div>
        ) : filtered.length === 0 ? (
          <div className="empty-state">{vehicles.length === 0 ? "No vehicles have been listed yet." : "No vehicles match your search."}</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Owner</th>
                <th>Vehicle</th>
                <th>Type / seats</th>
                <th>Availability note</th>
                <th>Listed</th>
                <th>Assigned to</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((v) => (
                <tr key={v.id}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{v.owner_name}</div>
                    <div style={{ color: "var(--text-muted)", fontSize: 12 }}>
                      {v.owner_email}{v.owner_phone ? <> · <PhoneLink phone={v.owner_phone} style={{ fontSize: 12 }} /></> : ""}
                    </div>
                  </td>
                  <td>
                    <div>{v.make_model}</div>
                    <div style={{ color: "var(--text-muted)", fontSize: 12 }}>{v.plate_number}</div>
                  </td>
                  <td style={{ color: "var(--text-muted)", fontSize: 12.5 }}>{v.vehicle_type} · {v.seats} seats</td>
                  <td style={{ color: "var(--text-muted)", fontSize: 12.5 }}>{v.availability_note || "—"}</td>
                  <td style={{ color: "var(--text-muted)", fontSize: 12.5 }}>{formatDateTime(v.created_at)}</td>
                  <td>
                    {v.assigned_driver_name ? (
                      <StatusPill
                        label={v.assigned_driver_verified ? `${v.assigned_driver_name} (verified)` : `${v.assigned_driver_name} (unverified)`}
                        tone={v.assigned_driver_verified ? "teal" : "amber"}
                      />
                    ) : (
                      <StatusPill label="Unassigned" tone="coral" />
                    )}
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
