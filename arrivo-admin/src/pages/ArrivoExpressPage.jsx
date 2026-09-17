import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../AuthContext";
import * as api from "../api";
import { StatusPill } from "../components/StatusPill";
import { formatDateTime } from "../utils";

const TABS = [
  { id: "config", label: "Config" },
  { id: "cancellations", label: "Ride Guarantee" },
  { id: "family-plans", label: "Family Plan" },
  { id: "launch-promos", label: "Launch Promos" },
  { id: "arrivo-share", label: "Arrivo Share" },
  { id: "partner-venues", label: "Partner Venues" },
];

function planLabel(planType) {
  if (planType === "lite") return "Family Lite";
  if (planType === "plus") return "Family Plus";
  if (planType === "max") return "Family Max";
  return planType;
}

function promoLabel(promoCode) {
  if (promoCode === "early_bird") return "🌅 Arrivo Early Bird";
  if (promoCode === "morning_commuter") return "⏰ Arrivo Morning Commuter";
  return promoCode;
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

// Launch Promos tab -- Phase 2's 30-day acquisition test (Early Bird,
// Morning Commuter, Midday Lucky Ride). Shows ride counts and total
// discount cost per time-window promo, plus the Lucky Ride draw history
// so support can confirm a winner actually got refunded on a given day.
function LaunchPromosTab({ token }) {
  const [byPromo, setByPromo] = useState([]);
  const [luckyRideDraws, setLuckyRideDraws] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.getLaunchPromos(token)
      .then(({ byPromo, luckyRideDraws }) => {
        setByPromo(byPromo);
        setLuckyRideDraws(luckyRideDraws);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [token]);

  const totalDiscountNaira = byPromo.reduce((sum, p) => sum + Number(p.total_discount_naira || 0), 0);
  const totalPromoRides = byPromo.reduce((sum, p) => sum + Number(p.ride_count || 0), 0);
  const totalLuckyWinners = luckyRideDraws.filter((d) => d.winning_ride_id).length;

  return (
    <div>
      <div className="stat-grid" style={{ marginBottom: 24 }}>
        <div className="stat-card">
          <div className="stat-num" style={{ color: "var(--teal)" }}>{totalPromoRides}</div>
          <div className="stat-label">Early Bird + Morning Commuter rides</div>
        </div>
        <div className="stat-card">
          <div className="stat-num" style={{ color: "var(--coral)" }}>₦{totalDiscountNaira.toLocaleString()}</div>
          <div className="stat-label">Total discount absorbed (drivers paid in full)</div>
        </div>
        <div className="stat-card">
          <div className="stat-num" style={{ color: "var(--amber)" }}>{totalLuckyWinners}</div>
          <div className="stat-label">Lucky Ride winners drawn</div>
        </div>
      </div>

      {error ? <div className="error-text">{error}</div> : null}

      <h3 style={{ margin: "0 0 12px" }}>Early Bird &amp; Morning Commuter</h3>
      <div className="table-wrap" style={{ marginBottom: 32 }}>
        {loading ? (
          <div className="empty-state">Loading launch promos…</div>
        ) : byPromo.length === 0 ? (
          <div className="empty-state">No Early Bird or Morning Commuter rides yet.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Promo</th>
                <th>Rides</th>
                <th>Total discount</th>
              </tr>
            </thead>
            <tbody>
              {byPromo.map((p) => (
                <tr key={p.promo_code}>
                  <td>{promoLabel(p.promo_code)}</td>
                  <td>{p.ride_count}</td>
                  <td>₦{Number(p.total_discount_naira).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <h3 style={{ margin: "0 0 12px" }}>Midday Lucky Ride — daily draws</h3>
      <div className="table-wrap">
        {loading ? (
          <div className="empty-state">Loading draw history…</div>
        ) : luckyRideDraws.length === 0 ? (
          <div className="empty-state">No Lucky Ride draws yet — the scheduler runs the first draw after 1pm Lagos time.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Winner</th>
                <th>Fare refunded</th>
                <th>Entries</th>
              </tr>
            </thead>
            <tbody>
              {luckyRideDraws.map((d) => (
                <tr key={d.draw_date}>
                  <td>{d.draw_date}</td>
                  <td>
                    {d.winner_name ? (
                      <>
                        <div style={{ fontWeight: 600 }}>{d.winner_name}</div>
                        <div style={{ color: "var(--text-muted)", fontSize: 12 }}>{d.winner_email}</div>
                      </>
                    ) : (
                      <span style={{ color: "var(--text-muted)" }}>No qualifying entries</span>
                    )}
                  </td>
                  <td>{d.winning_fare_naira ? `₦${Number(d.winning_fare_naira).toLocaleString()}` : "—"}</td>
                  <td>{d.entries_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// Arrivo Share tab -- reporting only, no editable settings of its own
// (its passenger cap is services/fare.js's MAX_PASSENGERS, shared with
// every other booking flow, not a config value). Shows shared-ride volume
// and, for support/investigation, exactly who was on each recent one.
function ArrivoShareTab({ token }) {
  const [summary, setSummary] = useState(null);
  const [recentShared, setRecentShared] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.getArrivoShare(token)
      .then(({ summary, recentShared }) => {
        setSummary(summary);
        setRecentShared(recentShared);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [token]);

  return (
    <div>
      <div className="stat-grid" style={{ marginBottom: 24 }}>
        <div className="stat-card">
          <div className="stat-num" style={{ color: "var(--teal)" }}>{summary ? Number(summary.shared_ride_count) : "—"}</div>
          <div className="stat-label">Shared rides</div>
        </div>
        <div className="stat-card">
          <div className="stat-num" style={{ color: "var(--amber)" }}>{summary ? Number(summary.total_co_riders) : "—"}</div>
          <div className="stat-label">Total co-riders added</div>
        </div>
      </div>

      {error ? <div className="error-text">{error}</div> : null}
      <div className="table-wrap">
        {loading ? (
          <div className="empty-state">Loading Arrivo Share rides…</div>
        ) : recentShared.length === 0 ? (
          <div className="empty-state">No Arrivo Share rides yet.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Ride</th>
                <th>Organizer</th>
                <th>Vehicle</th>
                <th>Co-riders</th>
                <th>Status</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {recentShared.map((r) => (
                <tr key={r.id}>
                  <td>
                    <div style={{ fontWeight: 600 }}>#{r.id}</div>
                    <div style={{ color: "var(--text-muted)", fontSize: 12 }}>{r.pickup_address}</div>
                  </td>
                  <td>{r.organizer_name}</td>
                  <td style={{ textTransform: "capitalize" }}>{r.vehicle_type}</td>
                  <td>{(r.co_riders || []).map((c) => c.name).join(", ") || <span style={{ color: "var(--text-muted)" }}>None yet</span>}</td>
                  <td><StatusPill label={r.ride_status} tone={r.ride_status === "completed" ? "teal" : r.ride_status === "cancelled" ? "coral" : "amber"} /></td>
                  <td style={{ color: "var(--text-muted)", fontSize: 12.5 }}>{formatDateTime(r.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

const VENUE_CATEGORIES = [
  { id: "club", label: "Club" },
  { id: "restaurant", label: "Restaurant" },
  { id: "other", label: "Other" },
];

// Partner Venues tab -- Grotto x RideArrivo's admin CRUD. Full create +
// inline edit (name/category/address/perk/active), same inline-editable
// spirit as ConfigTab above -- support/operations can see this list (the
// page-wide requireAnyRole), only "admin" tokens can actually create/edit
// (see routes/admin.js's requireRole("admin") on the mutating routes).
function PartnerVenuesTab({ token, isReadOnly }) {
  const [venues, setVenues] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [drafts, setDrafts] = useState({}); // venue id -> partial draft object
  const [savingId, setSavingId] = useState(null);
  const [rowError, setRowError] = useState({});

  const [newVenue, setNewVenue] = useState({ name: "", category: "club", address: "", perkDescription: "" });
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState(null);

  const load = useCallback(async () => {
    try {
      const { venues } = await api.getPartnerVenues(token);
      setVenues(venues);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const draftFor = (venue, field) => {
    const draft = drafts[venue.id];
    return draft && draft[field] !== undefined ? draft[field] : venue[field];
  };
  const setDraft = (venue, field, value) => {
    setDrafts((prev) => ({ ...prev, [venue.id]: { ...prev[venue.id], [field]: value } }));
  };

  const save = async (venue) => {
    const draft = drafts[venue.id] || {};
    setSavingId(venue.id);
    setRowError((prev) => ({ ...prev, [venue.id]: null }));
    try {
      await api.updatePartnerVenue(token, venue.id, {
        name: draft.name !== undefined ? draft.name : venue.name,
        category: draft.category !== undefined ? draft.category : venue.category,
        address: draft.address !== undefined ? draft.address : venue.address,
        perkDescription: draft.perk_description !== undefined ? draft.perk_description : venue.perk_description,
        isActive: draft.is_active !== undefined ? draft.is_active : venue.is_active,
      });
      await load();
      setDrafts((prev) => { const next = { ...prev }; delete next[venue.id]; return next; });
    } catch (e) {
      setRowError((prev) => ({ ...prev, [venue.id]: e.message }));
    } finally {
      setSavingId(null);
    }
  };

  const toggleActive = async (venue) => {
    setSavingId(venue.id);
    try {
      await api.updatePartnerVenue(token, venue.id, { isActive: !venue.is_active });
      await load();
    } catch (e) {
      setRowError((prev) => ({ ...prev, [venue.id]: e.message }));
    } finally {
      setSavingId(null);
    }
  };

  const create = async () => {
    if (!newVenue.name.trim() || !newVenue.address.trim()) {
      setCreateError("Name and address are required.");
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      await api.createPartnerVenue(token, newVenue);
      setNewVenue({ name: "", category: "club", address: "", perkDescription: "" });
      await load();
    } catch (e) {
      setCreateError(e.message);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div>
      {isReadOnly ? (
        <p style={{ color: "var(--text-muted)", fontSize: 12.5, marginBottom: 16, fontStyle: "italic" }}>
          Read-only view. Ask an administrator to add or edit partner venues.
        </p>
      ) : (
        <div className="table-wrap" style={{ marginBottom: 24, padding: 16 }}>
          <div style={{ fontWeight: 600, marginBottom: 12 }}>Add a partner venue</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
            <input className="field" placeholder="Name" style={{ flex: "1 1 160px" }}
              value={newVenue.name} onChange={(e) => setNewVenue((v) => ({ ...v, name: e.target.value }))} />
            <select className="field" style={{ flex: "0 0 130px" }}
              value={newVenue.category} onChange={(e) => setNewVenue((v) => ({ ...v, category: e.target.value }))}>
              {VENUE_CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
            <input className="field" placeholder="Address" style={{ flex: "2 1 240px" }}
              value={newVenue.address} onChange={(e) => setNewVenue((v) => ({ ...v, address: e.target.value }))} />
          </div>
          <input className="field" placeholder="Perk for riders (e.g. 'Skip the queue')" style={{ width: "100%", marginBottom: 8 }}
            value={newVenue.perkDescription} onChange={(e) => setNewVenue((v) => ({ ...v, perkDescription: e.target.value }))} />
          {createError ? <div className="error-text" style={{ marginBottom: 8 }}>{createError}</div> : null}
          <button className="btn primary" disabled={creating} onClick={create}>
            {creating ? "Adding…" : "Add venue"}
          </button>
        </div>
      )}

      {error ? <div className="error-text">{error}</div> : null}
      <div className="table-wrap">
        {loading ? (
          <div className="empty-state">Loading partner venues…</div>
        ) : venues.length === 0 ? (
          <div className="empty-state">No partner venues yet.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Category</th>
                <th>Address</th>
                <th>Perk</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {venues.map((venue) => {
                const dirty = !!drafts[venue.id];
                return (
                  <tr key={venue.id}>
                    <td>
                      <input className="field" style={{ width: 140 }} value={draftFor(venue, "name")}
                        disabled={isReadOnly} onChange={(e) => setDraft(venue, "name", e.target.value)} />
                    </td>
                    <td>
                      <select className="field" value={draftFor(venue, "category")}
                        disabled={isReadOnly} onChange={(e) => setDraft(venue, "category", e.target.value)}>
                        {VENUE_CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                      </select>
                    </td>
                    <td>
                      <input className="field" style={{ width: 200 }} value={draftFor(venue, "address")}
                        disabled={isReadOnly} onChange={(e) => setDraft(venue, "address", e.target.value)} />
                    </td>
                    <td>
                      <input className="field" style={{ width: 180 }} value={draftFor(venue, "perk_description") || ""}
                        disabled={isReadOnly} onChange={(e) => setDraft(venue, "perk_description", e.target.value)} />
                    </td>
                    <td>
                      <StatusPill label={venue.is_active ? "Active" : "Inactive"} tone={venue.is_active ? "teal" : "muted"} />
                    </td>
                    <td>
                      {!isReadOnly ? (
                        <div style={{ display: "flex", gap: 6 }}>
                          <button className="btn primary" disabled={!dirty || savingId === venue.id} onClick={() => save(venue)}>
                            {savingId === venue.id ? "Saving…" : "Save"}
                          </button>
                          <button className="btn ghost" disabled={savingId === venue.id} onClick={() => toggleActive(venue)}>
                            {venue.is_active ? "Deactivate" : "Activate"}
                          </button>
                        </div>
                      ) : null}
                      {rowError[venue.id] ? <div className="error-text" style={{ marginTop: 4 }}>{rowError[venue.id]}</div> : null}
                    </td>
                  </tr>
                );
              })}
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
      {tab === "launch-promos" ? <LaunchPromosTab token={token} /> : null}
      {tab === "arrivo-share" ? <ArrivoShareTab token={token} /> : null}
      {tab === "partner-venues" ? <PartnerVenuesTab token={token} isReadOnly={isReadOnly} /> : null}
    </div>
  );
}
