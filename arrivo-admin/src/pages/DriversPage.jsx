import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../AuthContext";
import * as api from "../api";
import { StatusPill } from "../components/StatusPill";
import { formatDateTime, downloadCsv } from "../utils";
import { PhoneLink } from "../components/PhoneLink";
import { CallButton } from "../components/CallButton";
import { confirmAction, askText, notify } from "../components/ConfirmDialog";

export const TIERS = [
  { id: "ride", label: "RideArrivo", tone: "teal" },
  { id: "express", label: "ArrivoExpress", tone: "coral" },
  { id: "chauffeur", label: "Chauffeur", tone: "muted" },
  { id: "air", label: "ArrivoAir", tone: "teal" },
  { id: "boat", label: "ArrivoBoat", tone: "teal" },
  { id: "removals", label: "ArrivoRemovals", tone: "coral" },
  { id: "campus", label: "ArrivoCampus", tone: "muted" },
];
export const tierOf = (d) => TIERS.find((t) => t.id === (d.tier || "ride")) || TIERS[0];

function exportDriversCsv(drivers) {
  downloadCsv(
    `arrivo-drivers-${new Date().toISOString().slice(0, 10)}.csv`,
    drivers,
    [
      { label: "Name", value: (d) => d.name },
      { label: "Email", value: (d) => d.email },
      { label: "Phone", value: (d) => d.phone || "" },
      { label: "Tier", value: (d) => tierOf(d).label },
      { label: "Vehicle", value: (d) => d.make_model || "" },
      { label: "Plate number", value: (d) => d.plate_number || "" },
      { label: "Vehicle type", value: (d) => d.vehicle_type || "" },
      { label: "License number", value: (d) => d.license_number || "" },
      { label: "LASDRI number", value: (d) => d.lasdri_number || "" },
      { label: "Joined", value: (d) => d.created_at || "" },
      { label: "Verified", value: (d) => (d.is_verified ? "Yes" : "No") },
      { label: "Online", value: (d) => (d.is_online ? "Yes" : "No") },
      { label: "Rating", value: (d) => d.rating ?? "" },
    ]
  );
}

export function DriversPage() {
  const { token, isReadOnly, isOperations } = useAuth();
  const [drivers, setDrivers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [engineStatus, setEngineStatus] = useState(null);
  const [showArchived, setShowArchived] = useState(false);
  const [tierFilter, setTierFilter] = useState("all");
  const [qrModal, setQrModal] = useState(null); // { driverName, imageUrl } | null
  const [qrLoadingId, setQrLoadingId] = useState(null);

  const load = useCallback(async () => {
    try {
      const { drivers, engineStatus } = await api.getDrivers(token, showArchived);
      setDrivers(drivers);
      setEngineStatus(engineStatus || null);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [token, showArchived]);

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

  const act = async (driver, fn, confirmText) => {
    if (confirmText && !await confirmAction(confirmText)) return;
    setBusyId(driver.id);
    try { await fn(); await load(); } catch (e) { setError(e.message); } finally { setBusyId(null); }
  };
  const changeTier = (d, tier) => act(d, () => api.setDriverTier(token, d.id, tier));
  const archive = (d, on) => act(d, () => api.archiveDriver(token, d.id, on), on ? `Archive ${d.name}? They go offline and are hidden. You can restore them later.` : null);
  const remove = (d) => act(d, () => api.deleteDriver(token, d.id), `Delete ${d.name} for good? This only works for test drivers with no trips, and cannot be undone.`);

  const shown = drivers.filter((d) => tierFilter === "all" || tierOf(d).id === tierFilter);
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
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <select className="field" value={tierFilter} onChange={(e) => setTierFilter(e.target.value)} aria-label="Filter by tier">
            <option value="all">All tiers</option>
            {TIERS.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
          <button className="btn ghost" onClick={() => setShowArchived((v) => !v)}>{showArchived ? "Show active" : "Show archived"}</button>
          <button className="btn ghost" onClick={() => exportDriversCsv(shown)}>Export CSV</button>
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

      {engineStatus && engineStatus !== "ok" && engineStatus !== "skipped" ? (
        <div className="error-text" role="status">
          {engineStatus === "not_configured" && "New ArrivoExpress drivers are not showing: set ARRIVO_ENGINE_URL and ARRIVO_ENGINE_OPS_TOKEN on this service."}
          {engineStatus === "token_rejected" && "New ArrivoExpress drivers are not showing: the engine rejected the token. ARRIVO_ENGINE_OPS_TOKEN must equal ARRIVO_OPS_TOKEN on the engine."}
          {engineStatus === "unreachable" && "New ArrivoExpress drivers are not showing: the engine could not be reached just now."}
        </div>
      ) : null}

      {error ? <div className="error-text">{error}</div> : null}

      <div className="table-wrap">
        {loading ? (
          <div className="empty-state">Loading drivers…</div>
        ) : shown.length === 0 ? (
          <div className="empty-state">{showArchived ? "No archived drivers." : "No drivers to show."}</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Driver</th>
                <th>Tier</th>
                <th>Vehicle</th>
                <th>License / LASDRI</th>
                <th>Joined</th>
                <th>Status</th>
                <th>Online</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {shown.map((d) => (
                <tr key={d.id}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{d.name}</div>
                    <div style={{ color: "var(--text-muted)", fontSize: 12 }}>{d.email}{d.phone ? <> · <PhoneLink phone={d.phone} style={{ fontSize: 12 }} /></> : ""}</div>
                    <div style={{ marginTop: 4 }}>
                      {/* d.id is drivers.id (this row's own primary key) —
                          NOT usable as a Stream user id. d.user_id is the
                          driver's actual users.id, joined server-side (see
                          arrivo-backend/routes/admin.js GET /drivers). */}
                      {!isOperations && d.source !== "engine" ? (<CallButton calleeUserId={d.user_id} calleeName={d.name} />) : null}
                    </div>
                  </td>
                  <td>
                    {isReadOnly || d.source === "engine" ? (
                      <StatusPill label={tierOf(d).label} tone={tierOf(d).tone} />
                    ) : (
                      <select className="field" value={d.tier || "ride"} disabled={busyId === d.id} onChange={(e) => changeTier(d, e.target.value)} aria-label={`Tier for ${d.name}`}>
                        {TIERS.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                      </select>
                    )}
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
                    <StatusPill label={d.is_verified ? "Verified" : d.verification_stage ? String(d.verification_stage).replace(/_/g, " ") : "Pending"} tone={d.is_verified ? "teal" : "coral"} />
                  </td>
                  <td>
                    <StatusPill label={d.is_online ? "Online" : "Offline"} tone={d.is_online ? "teal" : "muted"} />
                  </td>
                  <td>
                    {d.source === "engine" ? (
                      <span style={{ color: "var(--text-muted)", fontSize: 12 }}>Managed in Driver Verification</span>
                    ) : isReadOnly ? (
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
                    {!isReadOnly && d.source !== "engine" && (
                      showArchived ? (
                        <>
                          <button className="btn" style={{ marginLeft: 8 }} disabled={busyId === d.id} onClick={() => archive(d, false)}>Restore</button>
                          <button className="btn revoke" style={{ marginLeft: 8 }} disabled={busyId === d.id} onClick={() => remove(d)}>Delete</button>
                        </>
                      ) : (
                        <button className="btn" style={{ marginLeft: 8 }} disabled={busyId === d.id} onClick={() => archive(d, true)}>Archive</button>
                      )
                    )}
                    {d.is_verified && d.source !== "engine" && (
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
        <div className="modal-backdrop" onClick={closeQrModal}>
          <div
            className="modal-card"
            style={{ maxWidth: 360, textAlign: "center" }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ marginBottom: 4 }}>{qrModal.driverName}</h3>
            <p style={{ color: "var(--text-muted)", fontSize: 12.5, marginBottom: 16 }}>
              Print this and place it on the dashboard or a window placard. Riders scan it to confirm their driver and start live tracking.
            </p>
            {/* The QR PNG itself is rendered with a solid white background
                by the backend (routes/admin.js's qrcode.toBuffer), so it
                stays scannable regardless of this card's dark glass tint —
                only a light padding ring is added here to keep it from
                touching the card edge. */}
            <div style={{ background: "#fff", borderRadius: 8, padding: 8 }}>
              <img src={qrModal.imageUrl} alt="Driver placard QR code" style={{ width: "100%", display: "block", borderRadius: 4 }} />
            </div>
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
