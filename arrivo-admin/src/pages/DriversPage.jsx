import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../AuthContext";
import * as api from "../api";
import { StatusPill } from "../components/StatusPill";

export function DriversPage() {
  const { token } = useAuth();
  const [drivers, setDrivers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    try {
      const { drivers } = await api.getDrivers(token);
      setDrivers(drivers);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const toggleVerify = async (driver) => {
    setBusyId(driver.id);
    try {
      await api.verifyDriver(token, driver.id, !driver.is_verified);
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusyId(null);
    }
  };

  const pendingCount = drivers.filter((d) => !d.is_verified).length;

  return (
    <div>
      <div className="page-header">
        <div>
          <span className="eyebrow">Driver management</span>
          <h1>Drivers</h1>
        </div>
      </div>

      <div className="stat-grid" style={{ marginBottom: 24 }}>
        <div className="stat-card">
          <div className="stat-num" style={{ color: "var(--coral)" }}>{pendingCount}</div>
          <div className="stat-label">Awaiting verification</div>
        </div>
        <div className="stat-card">
          <div className="stat-num">{drivers.length}</div>
          <div className="stat-label">Total drivers</div>
        </div>
        <div className="stat-card">
          <div className="stat-num" style={{ color: "var(--teal)" }}>{drivers.filter((d) => d.is_online).length}</div>
          <div className="stat-label">Online now</div>
        </div>
      </div>

      {error ? <div className="error-text">{error}</div> : null}

      <div className="table-wrap">
        {loading ? (
          <div className="empty-state">Loading drivers…</div>
        ) : drivers.length === 0 ? (
          <div className="empty-state">No drivers have signed up yet.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Driver</th>
                <th>Vehicle</th>
                <th>License / LASDRI</th>
                <th>Status</th>
                <th>Online</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {drivers.map((d) => (
                <tr key={d.id}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{d.name}</div>
                    <div style={{ color: "var(--text-muted)", fontSize: 12 }}>{d.email}{d.phone ? ` · ${d.phone}` : ""}</div>
                  </td>
                  <td>
                    {d.make_model ? (
                      <>
                        <div>{d.make_model}</div>
                        <div style={{ color: "var(--text-muted)", fontSize: 12 }}>{d.plate_number} · {d.vehicle_type}</div>
                      </>
                    ) : (
                      <span style={{ color: "var(--text-muted)" }}>—</span>
                    )}
                  </td>
                  <td>
                    <div>{d.license_number || "—"}</div>
                    <div style={{ color: "var(--text-muted)", fontSize: 12 }}>{d.lasdri_number || "No LASDRI on file"}</div>
                  </td>
                  <td>
                    <StatusPill label={d.is_verified ? "Verified" : "Pending"} tone={d.is_verified ? "teal" : "coral"} />
                  </td>
                  <td>
                    <StatusPill label={d.is_online ? "Online" : "Offline"} tone={d.is_online ? "teal" : "muted"} />
                  </td>
                  <td>
                    <button
                      className={`btn ${d.is_verified ? "revoke" : "verify"}`}
                      disabled={busyId === d.id}
                      onClick={() => toggleVerify(d)}
                    >
                      {busyId === d.id ? "…" : d.is_verified ? "Revoke" : "Verify"}
                    </button>
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
