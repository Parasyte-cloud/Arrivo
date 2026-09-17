import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../AuthContext";
import * as api from "../api";
import { StatusPill } from "../components/StatusPill";
import { formatDateTime } from "../utils";

const TABS = [
  { id: "config", label: "Config" },
  { id: "cancellations", label: "Ride Guarantee" },
  { id: "family-plans", label: "Family Plan" },
];

function planLabel(planType) {
  if (planType === "lite") return "Family Lite";
  if (planType === "plus") return "Family Plus";
  if (planType === "max") return "Family Max";
  return planType;
}

function reasonLabel(reason) {
  switch (reason) {
    case "vehicle_breakdown": return "Vehicle breakdown";
    case "safety_concern": return "Safety concern";
    case "emergency": return "Emergency";
    case "incorrect_pickup_info": return "Wrong pickup info";
    default: return reason;
  }
}

// Config tab -- Fair Fare's allowance/rate and Family Plan's placeholder
// pricing (services/systemConfig.js), all explicitly "not yet finalised"
// per the brief and meant to be tuned here rather than redeployed.
function ConfigTab({ token, isReadOnly }) {
  const [config, setConfig] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [drafts, setDrafts] = useState({}); // key -> in-progress input value
  const [savingKey, setSavingKey] = useState(null);
  const [savedKey, setSavedKey] = useState(null);
  const [rowError, setRowError] = useState({});

  const load = useCallback(async () => {
    try {
      const { config } = await api.getSystemConfig(token);
      setConfig(config);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const draftFor = (row) => (drafts[row.key] !== undefined ? drafts[row.key] : row.value);

  const save = async (row) => {
    const value = draftFor(row);
    setSavingKey(row.key);
    setRowError((prev) => ({ ...prev, [row.key]: null }));
    try {
      await api.updateSystemConfig(token, row.key, value);
      await load();
      setDrafts((prev) => { const next = { ...prev }; delete next[row.key]; return next; });
      setSavedKey(row.key);
      setTimeout(() => setSavedKey((k) => (k === row.key ? null : k)), 2000);
    } catch (e) {
      setRowError((prev) => ({ ...prev, [row.key]: e.message }));
    } finally {
      setSavingKey(null);
    }
  };

  if (loading) return <div className="table-wrap"><div className="empty-state">Loading config…</div></div>;

  return (
    <div>
      {error ? <div className="error-text">{error}</div> : null}
      {isReadOnly ? (
        <p style={{ color: "var(--text-muted)", fontSize: 12.5, marginBottom: 16, fontStyle: "italic" }}>
          Read-only view. Ask an administrator to change these values.
        </p>
      ) : null}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Parameter</th>
              <th>Value</th>
              <th>Status</th>
              <th>Last updated</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {config.map((row) => {
              const dirty = drafts[row.key] !== undefined && drafts[row.key] !== row.value;
              return (
                <tr key={row.key}>
                  <td style={{ maxWidth: 340 }}>
                    <div style={{ fontWeight: 600, fontFamily: "monospace", fontSize: 12.5 }}>{row.key}</div>
                    <div style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 2 }}>{row.description}</div>
                    {rowError[row.key] ? <div className="error-text" style={{ marginTop: 4 }}>{rowError[row.key]}</div> : null}
                  </td>
                  <td>
                    <input
                      type="text"
                      className="field"
                      value={draftFor(row)}
                      onChange={(e) => setDrafts((prev) => ({ ...prev, [row.key]: e.target.value }))}
                      disabled={isReadOnly || savingKey === row.key}
                      style={{ width: 140 }}
                    />
                  </td>
                  <td>
                    {row.isDefault ? (
                      <StatusPill label="Default" tone="muted" />
                    ) : (
                      <StatusPill label="Overridden" tone="amber" />
                    )}
                  </td>
                  <td style={{ color: "var(--text-muted)", fontSize: 12.5 }}>
                    {row.updatedAt ? formatDateTime(row.updatedAt) : "Never — shipped default"}
                  </td>
                  <td>
                    {!isReadOnly ? (
                      <button
                        className="btn primary"
                        disabled={!dirty || savingKey === row.key}
                        onClick={() => save(row)}
                      >
                        {savingKey === row.key ? "Saving…" : savedKey === row.key ? "Saved ✓" : "Save"}
                      </button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Ride Guarantee tab -- every driver cancel-request attempt, valid or not,
// so support can spot patterns (a driver citing "vehicle breakdown" on
// every other trip) rather than only ever seeing the rider-side outcome.
function CancellationsTab({ token }) {
  const [cancellations, setCancellations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.getRideCancellations(token)
      .then(({ cancellations }) => setCancellations(cancellations))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [token]);

  return (
    <div>
      {error ? <div className="error-text">{error}</div> : null}
      <div className="table-wrap">
        {loading ? (
          <div className="empty-state">Loading cancellations…</div>
        ) : cancellations.length === 0 ? (
          <div className="empty-state">No driver cancel-requests yet — Ride Guarantee hasn't had to kick in.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Ride</th>
                <th>Driver</th>
                <th>Rider</th>
                <th>Reason</th>
                <th>Outcome</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {cancellations.map((c) => (
                <tr key={c.id}>
                  <td>
                    <div style={{ fontWeight: 600 }}>#{c.ride_id}</div>
                    <div style={{ color: "var(--text-muted)", fontSize: 12 }}>{c.pickup_address}</div>
                  </td>
                  <td>{c.driver_name || <span style={{ color: "var(--text-muted)" }}>Unknown</span>}</td>
                  <td>{c.rider_name || <span style={{ color: "var(--text-muted)" }}>Unknown</span>}</td>
                  <td>{reasonLabel(c.reason)}</td>
                  <td>
                    {c.reassigned ? (
                      <StatusPill label="Returned to pool" tone="teal" />
                    ) : (
                      <StatusPill label="Not reassigned" tone="coral" />
                    )}
                  </td>
                  <td style={{ color: "var(--text-muted)", fontSize: 12.5 }}>{formatDateTime(c.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// Family Plan tab -- every plan an admin has created, with member count
// and wallet balance, so support can see at a glance who's paying for
// what and whether a low-balance complaint checks out.
function FamilyPlansTab({ token }) {
  const [plans, setPlans] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.getFamilyPlans(token)
      .then(({ familyPlans }) => setPlans(familyPlans))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [token]);

  const activeCount = plans.filter((p) => p.status === "active").length;
  const totalMembers = plans.reduce((sum, p) => sum + Number(p.member_count || 0), 0);
  const totalWalletNaira = plans.reduce((sum, p) => sum + Number(p.wallet_balance_naira || 0), 0);

  return (
    <div>
      <div className="stat-grid" style={{ marginBottom: 24 }}>
        <div className="stat-card">
          <div className="stat-num" style={{ color: "var(--teal)" }}>{activeCount}</div>
          <div className="stat-label">Active plans</div>
        </div>
        <div className="stat-card">
          <div className="stat-num">{totalMembers}</div>
          <div className="stat-label">Total members</div>
        </div>
        <div className="stat-card">
          <div className="stat-num" style={{ color: "var(--amber)" }}>₦{totalWalletNaira.toLocaleString()}</div>
          <div className="stat-label">Combined wallet balance</div>
        </div>
      </div>

      {error ? <div className="error-text">{error}</div> : null}
      <div className="table-wrap">
        {loading ? (
          <div className="empty-state">Loading family plans…</div>
        ) : plans.length === 0 ? (
          <div className="empty-state">No family plans yet.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Administrator</th>
                <th>Plan</th>
                <th>Members</th>
                <th>Wallet balance</th>
                <th>Status</th>
                <th>Renews</th>
              </tr>
            </thead>
            <tbody>
              {plans.map((p) => (
                <tr key={p.id}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{p.admin_name}</div>
                    <div style={{ color: "var(--text-muted)", fontSize: 12 }}>{p.admin_email}</div>
                  </td>
                  <td>{planLabel(p.plan_type)} <span style={{ color: "var(--text-muted)", fontSize: 12 }}>(₦{Number(p.price_naira).toLocaleString()}/mo)</span></td>
                  <td>{p.member_count} / {p.max_members}</td>
                  <td>₦{Number(p.wallet_balance_naira).toLocaleString()}</td>
                  <td><StatusPill label={p.status} tone={p.status === "active" ? "teal" : "muted"} /></td>
                  <td style={{ color: "var(--text-muted)", fontSize: 12.5 }}>{formatDateTime(p.renews_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// Arrivo Express Phase 1 -- one page covering all three features from the
// 2026-09-17 engineering brief that shipped together: Ride Guarantee,
// Fair Fare, and Family Plan. Grouped as tabs under a single nav entry
// rather than three separate pages, since they shipped as one initiative
// and none of the three has enough ongoing volume yet to warrant its own
// permanent sidebar slot.
export function ArrivoExpressPage() {
  const { token, isReadOnly } = useAuth();
  const [tab, setTab] = useState("config");

  return (
    <div>
      <div className="page-header">
        <div>
          <span className="eyebrow">Arrivo Express — Phase 1</span>
          <h1>Ride Guarantee · Fair Fare · Family Plan</h1>
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`btn ${tab === t.id ? "primary" : "ghost"}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "config" ? <ConfigTab token={token} isReadOnly={isReadOnly} /> : null}
      {tab === "cancellations" ? <CancellationsTab token={token} /> : null}
      {tab === "family-plans" ? <FamilyPlansTab token={token} /> : null}
    </div>
  );
}
