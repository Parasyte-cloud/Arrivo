import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../AuthContext";
import * as api from "../api";
import { StatusPill } from "../components/StatusPill";
import { formatDateTime } from "../utils";
import { PhoneLink } from "../components/PhoneLink";

// Maps the users.id_verification_status column (see db/schema.sql /
// routes/auth.js POST /submit-id-verification) to a StatusPill tone.
function idVerificationTone(status) {
  switch (status) {
    case "verified": return "teal";
    case "pending": return "amber";
    case "rejected": return "coral";
    default: return "muted"; // unverified — rider hasn't submitted anything yet
  }
}

function idVerificationLabel(status) {
  switch (status) {
    case "verified": return "Verified";
    case "pending": return "Pending review";
    case "rejected": return "Rejected";
    default: return "Not submitted";
  }
}

export function RidersPage() {
  const { token, isReadOnly } = useAuth();
  const [riders, setRiders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all"); // 'all' | 'never_booked' | 'booked'
  const [busyId, setBusyId] = useState(null);
  const [idModal, setIdModal] = useState(null); // rider row | null — for viewing/reviewing a submitted ID photo

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

  const reviewId = async (rider, status) => {
    let rejectionReason;
    if (status === "rejected") {
      rejectionReason = window.prompt(`Reason for rejecting ${rider.name}'s ID (shown to the rider):`, "");
      if (rejectionReason === null) return; // admin cancelled the prompt
    }
    setBusyId(rider.id);
    try {
      await api.verifyRiderId(token, rider.id, status, rejectionReason);
      await load();
      setIdModal(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusyId(null);
    }
  };

  const neverBooked = riders.filter((r) => r.ride_count === 0).length;
  const pendingIdReviews = riders.filter((r) => r.id_verification_status === "pending").length;

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
        <div className="stat-card">
          <div className="stat-num" style={{ color: "var(--amber)" }}>{pendingIdReviews}</div>
          <div className="stat-label">ID reviews pending</div>
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
                <th>Wallet balance</th>
                <th>Last activity</th>
                <th>ID verification</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.id}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{r.name}</div>
                    <div style={{ color: "var(--text-muted)", fontSize: 12 }}>{r.email}{r.phone ? <> · <PhoneLink phone={r.phone} style={{ fontSize: 12 }} /></> : ""}</div>
                  </td>
                  <td style={{ color: "var(--text-muted)", fontSize: 12.5 }}>
                    {formatDateTime(r.created_at)}
                  </td>
                  <td>
                    {r.ride_count === 0 ? (
                      <StatusPill label="Never booked" tone="coral" />
                    ) : (
                      <StatusPill label={`${r.ride_count} ride${r.ride_count > 1 ? "s" : ""}`} tone="teal" />
                    )}
                  </td>
                  <td>₦{r.total_spent_naira.toLocaleString()}</td>
                  <td>₦{r.wallet_balance_naira.toLocaleString()}</td>
                  <td style={{ color: "var(--text-muted)", fontSize: 12.5 }}>
                    {r.last_ride_at ? formatDateTime(r.last_ride_at) : "—"}
                  </td>
                  <td>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <StatusPill
                        label={idVerificationLabel(r.id_verification_status)}
                        tone={idVerificationTone(r.id_verification_status)}
                      />
                      {r.id_document_url ? (
                        <button className="btn" onClick={() => setIdModal(r)}>
                          Review
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {idModal && (
        <div
          style={{
            position: "fixed", inset: 0, background: "rgba(18,18,59,0.6)",
            display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100,
          }}
          onClick={() => setIdModal(null)}
        >
          <div
            style={{ background: "#fff", borderRadius: 16, padding: 28, maxWidth: 420, textAlign: "center" }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ marginBottom: 4 }}>{idModal.name}'s ID</h3>
            <p style={{ color: "var(--text-muted)", fontSize: 12.5, marginBottom: 4 }}>
              <StatusPill
                label={idVerificationLabel(idModal.id_verification_status)}
                tone={idVerificationTone(idModal.id_verification_status)}
              />
            </p>
            {idModal.id_verification_status === "rejected" && idModal.id_verification_rejection_reason ? (
              <p style={{ color: "var(--coral)", fontSize: 12.5, margin: "8px 0" }}>
                Last rejection reason: {idModal.id_verification_rejection_reason}
              </p>
            ) : null}
            <img
              src={idModal.id_document_url}
              alt={`${idModal.name}'s submitted ID`}
              style={{ width: "100%", borderRadius: 8, border: "1px solid #eee", marginTop: 12 }}
            />
            {isReadOnly ? (
              <p style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 16 }}>View only</p>
            ) : (
              <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
                <button
                  className="btn verify"
                  style={{ flex: 1 }}
                  disabled={busyId === idModal.id}
                  onClick={() => reviewId(idModal, "verified")}
                >
                  {busyId === idModal.id ? "…" : "Verify"}
                </button>
                <button
                  className="btn revoke"
                  style={{ flex: 1 }}
                  disabled={busyId === idModal.id}
                  onClick={() => reviewId(idModal, "rejected")}
                >
                  {busyId === idModal.id ? "…" : "Reject"}
                </button>
              </div>
            )}
            <button className="btn" style={{ marginTop: 10, width: "100%" }} onClick={() => setIdModal(null)}>
              Close
            </button>
          </div>
        </div>
      )}
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
