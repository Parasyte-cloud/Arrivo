import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../AuthContext";
import * as api from "../api";
import { StatusPill } from "../components/StatusPill";
import { formatDateTime } from "../utils";
import { PhoneLink } from "../components/PhoneLink";

export function DriversPage() {
  const { token, isReadOnly } = useAuth();
  const [drivers, setDrivers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [qrModal, setQrModal] = useState(null); // { driverName, imageUrl } | null
  const [qrLoadingId, setQrLoadingId] = useState(null);

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

  const viewPlacard = async (driver) => {
    setQrLoadingId(driver.id);
    setError(null);
    try {
      const imageUrl = await api.getDriverQrImage(token, driver.id);
      setQrModal({ driverName: driver.name, imageUrl });
    } catch (e) {
      setError(e.message);
    } finally {
      setQrLoadingId(null);
    }
  };

  const closeQrModal = () => {
    if (qrModal) URL.revokeObjectURL(qrModal.imageUrl); // free the memory once done
    setQrModal(null);
  };

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
                <th>Joined</th>
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
                    <div style={{ color: "var(--text-muted)", fontSize: 12 }}>{d.email}{d.phone ? <> · <PhoneLink phone={d.phone} style={{ fontSize: 12 }} /></> : ""}</div>
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
                  <td style={{ color: "var(--text-muted)", fontSize: 12.5 }}>
                    {d.created_at ? formatDateTime(d.created_at) : "—"}
                  </td>
                  <td>
                    <StatusPill label={d.is_verified ? "Verified" : "Pending"} tone={d.is_verified ? "teal" : "coral"} />
                  </td>
                  <td>
                    <StatusPill label={d.is_online ? "Online" : "Offline"} tone={d.is_online ? "teal" : "muted"} />
                  </td>
                  <td>
                    {isReadOnly ? (
                      <span style={{ color: "var(--text-muted)", fontSize: 12 }}>View only</span>
                    ) : (
                      <button
                        className={`btn ${d.is_verified ? "revoke" : "verify"}`}
                        disabled={busyId === d.id}
                        onClick={() => toggleVerify(d)}
                      >
                        {busyId === d.id ? "…" : d.is_verified ? "Revoke" : "Verify"}
                      </button>
                    )}
                    {d.is_verified && (
                      <button
                        className="btn"
                        style={{ marginLeft: 8 }}
                        disabled={qrLoadingId === d.id}
                        onClick={() => viewPlacard(d)}
                        title="View this driver's printable QR placard"
                      >
                        {qrLoadingId === d.id ? "…" : "Placard QR"}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {qrModal && (
        <div
          style={{
            position: "fixed", inset: 0, background: "rgba(18,18,59,0.6)",
            display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100,
          }}
          onClick={closeQrModal}
        >
          <div
            style={{ background: "#fff", borderRadius: 16, padding: 28, maxWidth: 360, textAlign: "center" }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ marginBottom: 4 }}>{qrModal.driverName}</h3>
            <p style={{ color: "var(--text-muted)", fontSize: 12.5, marginBottom: 16 }}>
              Print this and place it on the dashboard or a window placard. Riders scan it to confirm their driver and start live tracking.
            </p>
            <img src={qrModal.imageUrl} alt="Driver placard QR code" style={{ width: "100%", borderRadius: 8, border: "1px solid #eee" }} />
            <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
              <a
                href={qrModal.imageUrl}
                download={`${qrModal.driverName.replace(/\s+/g, "-")}-placard-qr.png`}
                className="btn verify"
                style={{ flex: 1, textAlign: "center", textDecoration: "none" }}
              >
                Download
              </a>
              <button className="btn" style={{ flex: 1 }} onClick={closeQrModal}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
