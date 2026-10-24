import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "../AuthContext";
import * as api from "../api";
import { StatusPill, rideStatusTone } from "../components/StatusPill";
import { formatDateTime, downloadCsv } from "../utils";
import { CallButton } from "../components/CallButton";
import { openInWindow } from "../lib/openWindow";
import "../riders.css";

const PAGE_SIZE = 50;

function exportRidersCsv(riders) {
  downloadCsv(
    `arrivo-riders-${new Date().toISOString().slice(0, 10)}.csv`,
    riders,
    [
      { label: "Name", value: (r) => r.name },
      { label: "Email", value: (r) => r.email },
      { label: "Phone", value: (r) => r.phone || "" },
      { label: "WhatsApp", value: (r) => r.whatsapp_number || "" },
      { label: "Language", value: (r) => r.preferred_language || "" },
      { label: "Signed up", value: (r) => r.created_at },
      { label: "Rides", value: (r) => r.ride_count },
      { label: "Total spent (NGN)", value: (r) => r.total_spent_naira },
      { label: "Wallet balance (NGN)", value: (r) => r.wallet_balance_naira },
      { label: "Last activity", value: (r) => r.last_ride_at || "" },
      { label: "ID verification", value: (r) => r.id_verification_status },
    ]
  );
}

// users.id_verification_status -> StatusPill tone / label.
function idVerificationTone(status) {
  switch (status) {
    case "verified": return "teal";
    case "pending": return "amber";
    case "rejected": return "coral";
    default: return "muted";
  }
}

function idVerificationLabel(status) {
  switch (status) {
    case "verified": return "Verified";
    case "pending": return "Needs review";
    case "rejected": return "Rejected";
    default: return "Not submitted";
  }
}

const naira = (n) => (n === null || n === undefined || Number.isNaN(Number(n)) ? "-" : `₦${Number(n).toLocaleString()}`);

function timeAgo(iso) {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diff)) return "";
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

function initials(name) {
  const parts = String(name || "?").trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] || "?") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

// A stable hue per rider so the same person always gets the same avatar colour.
function hueFor(id) {
  const s = String(id);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

// wa.me needs digits only, with the country code. A local Nigerian 0XXXXXXXXXX becomes 234XXXXXXXXXX.
function whatsappHref(number) {
  let digits = String(number || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 11 && digits.startsWith("0")) digits = `234${digits.slice(1)}`;
  return `https://wa.me/${digits}`;
}

const FILTERS = [
  { key: "all", label: "All" },
  { key: "booked", label: "Booked" },
  { key: "never", label: "Never booked" },
  { key: "id", label: "ID to review" },
  { key: "nophone", label: "No phone" },
];

const SORTS = [
  { key: "newest", label: "Newest signups" },
  { key: "rides", label: "Most rides" },
  { key: "spent", label: "Highest spend" },
  { key: "wallet", label: "Wallet balance" },
  { key: "active", label: "Recently active" },
];

const hasPhone = (r) => Boolean((r.phone && r.phone.trim()) || (r.whatsapp_number && r.whatsapp_number.trim()));

function Avatar({ rider, size = 40 }) {
  const hue = hueFor(rider.id);
  return (
    <span
      className="rd-avatar"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.36,
        background: `linear-gradient(135deg, hsl(${hue} 70% 55% / .9), hsl(${(hue + 40) % 360} 70% 40% / .9))`,
      }}
      aria-hidden="true"
    >
      {initials(rider.name)}
    </span>
  );
}

function ContactChips({ rider, stop }) {
  // Only an explicit WhatsApp number gets a chip here; a plain phone number may not be on WhatsApp.
  const wa = whatsappHref(rider.whatsapp_number);
  const wrap = stop ? (e) => e.stopPropagation() : undefined;
  return (
    <div className="rd-chips" onClick={wrap}>
      {rider.phone ? (
        <a className="rd-chip" href={`tel:${rider.phone}`} title="Call on your phone">📞 {rider.phone}</a>
      ) : (
        <span className="rd-chip warn">No phone on file</span>
      )}
      {wa ? <a className="rd-chip wa" href={wa} target="_blank" rel="noreferrer" title="Open WhatsApp">WhatsApp</a> : null}
    </div>
  );
}

export function RidersPage() {
  const { token, isReadOnly, can } = useAuth();
  const [riders, setRiders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [sort, setSort] = useState("newest");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [selectedId, setSelectedId] = useState(null);

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

  const counts = useMemo(() => ({
    all: riders.length,
    booked: riders.filter((r) => r.ride_count > 0).length,
    never: riders.filter((r) => r.ride_count === 0).length,
    id: riders.filter((r) => r.id_verification_status === "pending").length,
    nophone: riders.filter((r) => !hasPhone(r)).length,
  }), [riders]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = riders.filter((r) => {
      if (filter === "booked" && r.ride_count === 0) return false;
      if (filter === "never" && r.ride_count !== 0) return false;
      if (filter === "id" && r.id_verification_status !== "pending") return false;
      if (filter === "nophone" && hasPhone(r)) return false;
      if (!q) return true;
      return (
        String(r.name || "").toLowerCase().includes(q) ||
        String(r.email || "").toLowerCase().includes(q) ||
        String(r.phone || "").includes(q) ||
        String(r.whatsapp_number || "").includes(q)
      );
    });
    const time = (v) => (v ? new Date(v).getTime() : 0);
    const by = {
      newest: (a, b) => time(b.created_at) - time(a.created_at),
      rides: (a, b) => b.ride_count - a.ride_count,
      spent: (a, b) => b.total_spent_naira - a.total_spent_naira,
      wallet: (a, b) => b.wallet_balance_naira - a.wallet_balance_naira,
      active: (a, b) => time(b.last_ride_at) - time(a.last_ride_at),
    }[sort];
    return [...list].sort(by);
  }, [riders, search, filter, sort]);

  useEffect(() => { setLimit(PAGE_SIZE); }, [search, filter, sort]);

  const selected = riders.find((r) => r.id === selectedId) || null;
  const shown = visible.slice(0, limit);

  const tiles = [
    { key: "all", num: counts.all, label: "Total signups", tone: "" },
    { key: "booked", num: counts.booked, label: "Booked at least once", tone: "teal" },
    { key: "never", num: counts.never, label: "Signed up, never booked", tone: "coral" },
    { key: "id", num: counts.id, label: "ID reviews pending", tone: "amber" },
    { key: "nophone", num: counts.nophone, label: "No phone on file", tone: "amber" },
  ];

  return (
    <div className="rd-page">
      <div className="page-header">
        <div>
          <span className="eyebrow">Rider accounts</span>
          <h1>Riders</h1>
          <p className="rd-sub">Who signed up, who is booking, and who needs a follow-up. Select a rider for the full picture.</p>
        </div>
        <div className="rd-actions">
          <button className="btn ghost" onClick={() => exportRidersCsv(visible)}>Export CSV</button>
          <button className="btn ghost" onClick={() => exportWaitlistCsv(token)}>Waitlist CSV</button>
        </div>
      </div>

      <div className="rd-tiles">
        {tiles.map((t) => (
          <button
            key={t.key}
            type="button"
            className={`rd-tile ${t.tone} ${filter === t.key ? "on" : ""}`}
            onClick={() => setFilter(t.key)}
            aria-pressed={filter === t.key}
          >
            <span className="rd-tile-num">{t.num}</span>
            <span className="rd-tile-label">{t.label}</span>
          </button>
        ))}
      </div>

      <div className="rd-toolbar">
        <input
          type="search"
          placeholder="Search name, email or phone…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="field rd-search"
          aria-label="Search riders"
        />
        <div className="rd-seg" role="tablist" aria-label="Filter riders">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              role="tab"
              aria-selected={filter === f.key}
              className={filter === f.key ? "on" : ""}
              onClick={() => setFilter(f.key)}
            >
              {f.label} <span>{counts[f.key]}</span>
            </button>
          ))}
        </div>
        <select className="field rd-sort" value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort riders">
          {SORTS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
      </div>

      {error ? <div className="error-text">{error}</div> : null}

      <div className="rd-list" role="list">
        {loading ? (
          <div className="empty-state">Loading riders…</div>
        ) : visible.length === 0 ? (
          <div className="empty-state">{riders.length === 0 ? "No riders have signed up yet." : "No riders match this view."}</div>
        ) : (
          <>
            <div className="rd-row rd-head" aria-hidden="true">
              <span>Rider</span><span>Contact</span><span>Activity</span><span>Wallet</span><span>ID</span><span />
            </div>
            {shown.map((r) => (
              <div
                key={r.id}
                role="listitem"
                tabIndex={0}
                className={`rd-row ${selectedId === r.id ? "active" : ""}`}
                onClick={() => setSelectedId(r.id)}
                onKeyDown={(e) => { if (e.key === "Enter") setSelectedId(r.id); }}
              >
                <div className="rd-who">
                  <Avatar rider={r} />
                  <div className="rd-who-text">
                    <strong>{r.name}</strong>
                    <span>Joined {timeAgo(r.created_at)}</span>
                  </div>
                </div>

                <div className="rd-contact">
                  <ContactChips rider={r} stop />
                  <span className="rd-email">{r.email}</span>
                </div>

                <div className="rd-activity">
                  {r.ride_count === 0 ? (
                    <StatusPill label="Never booked" tone="coral" />
                  ) : (
                    <StatusPill label={`${r.ride_count} ride${r.ride_count > 1 ? "s" : ""}`} tone="teal" />
                  )}
                  <span className="rd-meta">
                    {r.ride_count > 0 ? `${naira(r.total_spent_naira)} spent · last ${timeAgo(r.last_ride_at)}` : "No rides yet"}
                  </span>
                </div>

                <div className="rd-wallet">
                  <span className="rd-label">Wallet</span>
                  <strong>{naira(r.wallet_balance_naira)}</strong>
                </div>

                <div className="rd-id">
                  <StatusPill label={idVerificationLabel(r.id_verification_status)} tone={idVerificationTone(r.id_verification_status)} />
                </div>

                <div className="rd-go" onClick={(e) => e.stopPropagation()}>
                  <CallButton calleeUserId={r.id} calleeName={r.name} />
                </div>
              </div>
            ))}
          </>
        )}
      </div>

      {!loading && visible.length > 0 ? (
        <div className="rd-foot">
          <span>Showing {shown.length} of {visible.length}</span>
          {visible.length > shown.length ? (
            <button className="btn ghost" onClick={() => setLimit((n) => n + PAGE_SIZE)}>Show more</button>
          ) : null}
        </div>
      ) : null}

      {selected ? (
        <RiderDrawer
          rider={selected}
          token={token}
          isReadOnly={isReadOnly}
          canAdjustWallet={can("wallet", "manage")}
          onClose={() => setSelectedId(null)}
          onChanged={load}
        />
      ) : null}
    </div>
  );
}

function Fact({ label, children }) {
  return (
    <div className="rd-fact">
      <span>{label}</span>
      <strong>{children}</strong>
    </div>
  );
}

export function RiderDrawer({ rider, token, isReadOnly, canAdjustWallet, onClose, onChanged, variant = "drawer" }) {
  const [rides, setRides] = useState(null);
  const [txns, setTxns] = useState(null);
  const [detailError, setDetailError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [adjusting, setAdjusting] = useState(false);
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Recent rides and wallet movements load when a rider is opened, not for the whole list.
  useEffect(() => {
    let live = true;
    setRides(null);
    setTxns(null);
    setDetailError(null);
    setRejecting(false);
    setAdjusting(false);
    setActionError(null);
    api.getRides(token, { search: rider.email })
      .then(({ rides }) => { if (live) setRides((rides || []).filter((x) => x.rider_email === rider.email).slice(0, 5)); })
      .catch((e) => { if (live) { setRides([]); setDetailError(e.message); } });
    api.getWalletTransactions(token, rider.id)
      .then(({ transactions }) => { if (live) setTxns((transactions || []).slice(0, 5)); })
      .catch((e) => { if (live) { setTxns([]); setDetailError(e.message); } });
    return () => { live = false; };
  }, [token, rider.id, rider.email]);

  const review = async (status) => {
    setBusy(true);
    setActionError(null);
    try {
      await api.verifyRiderId(token, rider.id, status, status === "rejected" ? reason.trim() : undefined);
      setRejecting(false);
      setReason("");
      await onChanged();
    } catch (e) {
      setActionError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const applyAdjustment = async () => {
    const value = Number(amount);
    if (!Number.isFinite(value) || value === 0) {
      setActionError("Enter a non-zero amount: positive to credit, negative to debit.");
      return;
    }
    if (!description.trim()) {
      setActionError("A description is required so this stays traceable.");
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      await api.adjustRiderWallet(token, rider.id, value, description.trim());
      setAdjusting(false);
      setAmount("");
      setDescription("");
      await onChanged();
      const { transactions } = await api.getWalletTransactions(token, rider.id);
      setTxns((transactions || []).slice(0, 5));
    } catch (e) {
      setActionError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const wa = whatsappHref(rider.whatsapp_number || rider.phone);
  const average = rider.ride_count > 0 ? Math.round(rider.total_spent_naira / rider.ride_count) : null;

  const isPage = variant === "page";
  return (
    <div className={isPage ? "rd-page-wrap" : "rd-drawer-wrap"}>
      {isPage ? null : <div className="rd-backdrop" onClick={onClose} />}
      <aside className={`rd-drawer${isPage ? " page" : ""}`} role={isPage ? "main" : "dialog"} aria-label={`${rider.name} details`}>
        <header className="rd-d-head">
          <Avatar rider={rider} size={52} />
          <div className="rd-d-title">
            <h2>{rider.name}</h2>
            <span>Joined {formatDateTime(rider.created_at)}</span>
          </div>
          {isPage ? null : (
            <button className="btn ghost rd-close" onClick={() => openInWindow(`rider/${rider.id}`, rider.name)} title="Open in its own window">⤢ Window</button>
          )}
          {isPage ? null : <button className="btn ghost rd-close" onClick={onClose} aria-label="Close">✕</button>}
        </header>

        <div className="rd-d-actions">
          <CallButton calleeUserId={rider.id} calleeName={rider.name} />
          {rider.phone ? <a className="btn ghost" href={`tel:${rider.phone}`}>Phone</a> : null}
          {wa ? <a className="btn ghost" href={wa} target="_blank" rel="noreferrer">WhatsApp</a> : null}
          <a className="btn ghost" href={`mailto:${rider.email}`}>Email</a>
        </div>

        {!hasPhone(rider) ? (
          <div className="rd-note warn">
            This rider has no phone or WhatsApp number, so the team cannot reach them if a trip goes wrong.
            Ask them to add one under Profile. New bookings now require it.
          </div>
        ) : null}

        <section className="rd-section">
          <h3>Account</h3>
          <div className="rd-facts">
            <Fact label="Email">{rider.email}</Fact>
            <Fact label="Phone">{rider.phone || "Not provided"}</Fact>
            <Fact label="WhatsApp">{rider.whatsapp_number || "Not provided"}</Fact>
            <Fact label="Language">{rider.preferred_language || "Not set"}</Fact>
          </div>
        </section>

        <section className="rd-section">
          <h3>Value</h3>
          <div className="rd-facts">
            <Fact label="Rides">{rider.ride_count}</Fact>
            <Fact label="Total spent">{naira(rider.total_spent_naira)}</Fact>
            <Fact label="Average fare">{average === null ? "-" : naira(average)}</Fact>
            <Fact label="Last ride">{rider.last_ride_at ? `${timeAgo(rider.last_ride_at)}` : "None"}</Fact>
          </div>
        </section>

        <section className="rd-section">
          <h3>Recent rides</h3>
          {rides === null ? <p className="rd-muted">Loading…</p> : rides.length === 0 ? (
            <p className="rd-muted">No rides to show.</p>
          ) : (
            <ul className="rd-mini">
              {rides.map((x) => (
                <li key={x.id}>
                  <div>
                    <strong>{x.pickup_address || `Ride #${x.id}`}</strong>
                    <span>{x.flight_number ? `Flight ${x.flight_number} · ` : ""}{formatDateTime(x.created_at)}</span>
                  </div>
                  <div className="rd-mini-right">
                    <span>{naira(x.fare_naira)}</span>
                    <StatusPill label={String(x.ride_status || "").replace("_", " ")} tone={rideStatusTone(x.ride_status)} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rd-section">
          <div className="rd-sec-head">
            <h3>Wallet</h3>
            <strong className="rd-balance">{naira(rider.wallet_balance_naira)}</strong>
          </div>
          {txns === null ? <p className="rd-muted">Loading…</p> : txns.length === 0 ? (
            <p className="rd-muted">No wallet activity yet.</p>
          ) : (
            <ul className="rd-mini">
              {txns.map((t) => (
                <li key={t.id}>
                  <div>
                    <strong>{String(t.type).replace("_", " ")}</strong>
                    <span>{t.description || formatDateTime(t.created_at)}</span>
                  </div>
                  <div className="rd-mini-right">
                    <span className={t.amount_naira >= 0 ? "pos" : "neg"}>{t.amount_naira >= 0 ? "+" : "−"}{naira(Math.abs(t.amount_naira))}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {/* Moving money is the Wallet permission, not Riders. */}
          {canAdjustWallet ? (
            adjusting ? (
              <div className="rd-form">
                <input
                  type="number"
                  className="field"
                  placeholder="Amount: 2000 to credit, -2000 to debit"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
                <textarea
                  className="notes"
                  placeholder="Why? e.g. Refund for ride #482, driver took a wrong detour"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
                <div className="rd-form-row">
                  <button className="btn primary" disabled={busy} onClick={applyAdjustment}>{busy ? "Applying…" : "Apply adjustment"}</button>
                  <button className="btn" disabled={busy} onClick={() => { setAdjusting(false); setActionError(null); }}>Cancel</button>
                </div>
                <p className="rd-muted">Logged in the Wallet ledger with your account on the description.</p>
              </div>
            ) : (
              <button className="btn" onClick={() => { setAdjusting(true); setActionError(null); }}>Adjust wallet</button>
            )
          ) : null}
        </section>

        <section className="rd-section">
          <div className="rd-sec-head">
            <h3>ID verification</h3>
            <StatusPill label={idVerificationLabel(rider.id_verification_status)} tone={idVerificationTone(rider.id_verification_status)} />
          </div>
          {rider.id_verification_status === "rejected" && rider.id_verification_rejection_reason ? (
            <p className="rd-note warn">Last rejection reason: {rider.id_verification_rejection_reason}</p>
          ) : null}
          {rider.id_document_url ? (
            <a href={rider.id_document_url} target="_blank" rel="noreferrer">
              <img className="rd-id-img" src={rider.id_document_url} alt={`${rider.name}'s submitted ID`} />
            </a>
          ) : (
            <p className="rd-muted">No ID document submitted.</p>
          )}
          {!isReadOnly && rider.id_document_url ? (
            rejecting ? (
              <div className="rd-form">
                <textarea
                  className="notes"
                  placeholder="Reason for rejecting (shown to the rider)"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
                <div className="rd-form-row">
                  <button className="btn revoke" disabled={busy} onClick={() => review("rejected")}>{busy ? "…" : "Confirm reject"}</button>
                  <button className="btn" disabled={busy} onClick={() => setRejecting(false)}>Cancel</button>
                </div>
              </div>
            ) : (
              <div className="rd-form-row">
                <button className="btn verify" disabled={busy} onClick={() => review("verified")}>{busy ? "…" : "Verify"}</button>
                <button className="btn revoke" disabled={busy} onClick={() => setRejecting(true)}>Reject</button>
              </div>
            )
          ) : null}
          {isReadOnly ? <p className="rd-muted">View only</p> : null}
        </section>

        {actionError ? <div className="error-text">{actionError}</div> : null}
        {detailError ? <div className="rd-muted">Some details could not be loaded: {detailError}</div> : null}
      </aside>
    </div>
  );
}

function exportWaitlistCsv(token) {
  api.getWaitlist(token).then(({ waitlist }) => {
    // Goes through the shared downloadCsv() helper so values starting with = + - @
    // cannot run as spreadsheet formulas, and commas and quotes are escaped.
    downloadCsv(
      `arrivo-waitlist-${new Date().toISOString().slice(0, 10)}.csv`,
      waitlist,
      [
        { label: "email", value: (w) => w.email },
        { label: "source", value: (w) => w.source || "" },
        { label: "signed_up_at", value: (w) => w.created_at },
      ]
    );
  }).catch((e) => {
    console.error("Failed to export waitlist CSV:", e.message);
    window.alert("Couldn't export the waitlist CSV: " + (e.message || "please try again."));
  });
}
