import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../AuthContext";
import * as api from "../api";
import { StatusPill } from "../components/StatusPill";
import { formatDateTime } from "../utils";

function membershipTone(status) {
  switch (status) {
    case "active": return "teal";
    case "cancelled": return "coral";
    default: return "muted"; // expired
  }
}

function planLabel(m) {
  if (m.plan_type === "individual_annual") return "Individual annual";
  if (m.plan_type === "corporate_delegate") return m.company_account_id ? "Corporate delegate" : "Corporate account";
  return m.plan_type;
}

// Shows every membership row from db/schema.sql's `memberships` table —
// individual annual subscriptions, a company's own corporate account, and
// each delegate rider linked underneath one. Before this page existed,
// none of this real subscription revenue was visible anywhere in the
// admin panel; the only way to check a membership's status was a direct
// database query (see routes/admin.js GET /memberships).
export function MembershipsPage() {
  const { token } = useAuth();
  const [memberships, setMemberships] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    try {
      const { memberships } = await api.getMemberships(token);
      setMemberships(memberships);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const activeCount = memberships.filter((m) => m.status === "active").length;
  const individualCount = memberships.filter((m) => m.plan_type === "individual_annual" && m.status === "active").length;
  const corporateAccounts = memberships.filter((m) => m.plan_type === "corporate_delegate" && !m.company_account_id && m.status === "active").length;
  const delegateCount = memberships.filter((m) => m.plan_type === "corporate_delegate" && m.company_account_id && m.status === "active").length;
  const activeRevenueNaira = memberships.filter((m) => m.status === "active").reduce((sum, m) => sum + m.price_naira, 0);

  const filtered = memberships.filter((m) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      m.user_name.toLowerCase().includes(q) ||
      m.user_email.toLowerCase().includes(q) ||
      (m.company_name || "").toLowerCase().includes(q)
    );
  });

  return (
    <div>
      <div className="page-header">
        <div>
          <span className="eyebrow">Subscription revenue</span>
          <h1>Memberships</h1>
        </div>
      </div>

      <div className="stat-grid" style={{ marginBottom: 24 }}>
        <div className="stat-card">
          <div className="stat-num" style={{ color: "var(--teal)" }}>{activeCount}</div>
          <div className="stat-label">Active memberships</div>
        </div>
        <div className="stat-card">
          <div className="stat-num">{individualCount}</div>
          <div className="stat-label">Individual annual</div>
        </div>
        <div className="stat-card">
          <div className="stat-num">{corporateAccounts}</div>
          <div className="stat-label">Corporate accounts</div>
        </div>
        <div className="stat-card">
          <div className="stat-num">{delegateCount}</div>
          <div className="stat-label">Linked delegates</div>
        </div>
        <div className="stat-card">
          <div className="stat-num" style={{ color: "var(--amber)" }}>₦{activeRevenueNaira.toLocaleString()}</div>
          <div className="stat-label">Active subscription value</div>
        </div>
      </div>

      <input
        type="text"
        placeholder="Search member, email, or company…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="field"
        style={{ marginBottom: 20, minWidth: 220, maxWidth: 320 }}
      />

      {error ? <div className="error-text">{error}</div> : null}

      <div className="table-wrap">
        {loading ? (
          <div className="empty-state">Loading memberships…</div>
        ) : filtered.length === 0 ? (
          <div className="empty-state">{memberships.length === 0 ? "No memberships yet." : "No memberships match your search."}</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Member</th>
                <th>Plan</th>
                <th>Billed via</th>
                <th>Status</th>
                <th>Started</th>
                <th>Expires</th>
                <th>Price</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((m) => (
                <tr key={m.id}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{m.user_name}</div>
                    <div style={{ color: "var(--text-muted)", fontSize: 12 }}>{m.user_email}</div>
                  </td>
                  <td>{planLabel(m)}</td>
                  <td style={{ color: "var(--text-muted)", fontSize: 12.5 }}>
                    {m.company_account_id ? (
                      <>
                        <div>{m.company_name}</div>
                        <div>{m.company_email}</div>
                      </>
                    ) : (
                      "Own wallet"
                    )}
                  </td>
                  <td><StatusPill label={m.status} tone={membershipTone(m.status)} /></td>
                  <td style={{ color: "var(--text-muted)", fontSize: 12.5 }}>{formatDateTime(m.started_at)}</td>
                  <td style={{ color: "var(--text-muted)", fontSize: 12.5 }}>{formatDateTime(m.expires_at)}</td>
                  <td>₦{m.price_naira.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
