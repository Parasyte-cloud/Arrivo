import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../AuthContext";
import * as api from "../api";
import wordmarkLight from "../assets/wordmark-light.png";
import { OpsIcon } from "./OpsIcon";

// Grouped by the job someone is doing, not by which table the page reads.
// Who sees what is still decided by can(item.id), so this is only the layout.
const NAV_GROUPS = [
  {
    label: "Live",
    items: [
      { id: "overview", label: "Overview", icon: "overview" },
      { id: "ride-desk", label: "Ride Desk", icon: "headset" },
      { id: "trip-tracker", label: "Trip Tracker", icon: "radar" },
      { id: "live-map", label: "Live Map", icon: "map" },
      { id: "rides", label: "Rides", icon: "layers" },
      { id: "support", label: "Support Tickets", icon: "message" },
    ],
  },
  {
    label: "People & fleet",
    items: [
      { id: "riders", label: "Riders", icon: "users" },
      { id: "drivers", label: "Drivers", icon: "car" },
      { id: "driver-tiers", label: "Driver Tiers", icon: "shield" },
      { id: "vehicles", label: "Vehicles", icon: "car" },
    ],
  },
  {
    label: "Money",
    items: [
      { id: "wallet", label: "Wallet", icon: "wallet" },
      { id: "memberships", label: "Memberships", icon: "ticket" },
      { id: "express-pricing", label: "Express Pricing", icon: "pricing" },
      { id: "flight-issues", label: "Flight Issues", icon: "plane", badgeColor: "var(--amber)" },
    ],
  },
  {
    label: "Safety",
    items: [
      { id: "panics", label: "Panic Alerts", icon: "alert", danger: true, badgeColor: "var(--coral)" },
      { id: "safety", label: "Trip Safety", icon: "compass" },
    ],
  },
  {
    label: "Platform",
    items: [
      { id: "arrivo-express", label: "Arrivo Express", icon: "shield" },
      { id: "analytics", label: "Analytics", icon: "chart" },
      { id: "exports", label: "Exports", icon: "download" },
    ],
  },
];

// The web side (journeys, KYC documents, WhatsApp) lives in the Engine Ops page.
// One door for both, so nobody has to remember a second address.
const ENGINE_OPS_URL = import.meta.env.VITE_ENGINE_OPS_URL || "https://www.ridearrivo.com/ops";

export function Sidebar({ page, setPage, open, onClose, collapsed, setCollapsed }) {
  const { user, token, logout, access, can } = useAuth();
  const [panicCount, setPanicCount] = useState(0);
  const [flightIssueCount, setFlightIssueCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    function poll() {
      if (can("panics")) api.getPanics(token).then(({ panics }) => { if (!cancelled) setPanicCount(panics.length); }).catch(() => {});
      if (can("flight-issues")) api.getFlightIssues(token).then(({ flightIssues }) => { if (!cancelled) setFlightIssueCount(flightIssues.length); }).catch(() => {});
    }
    poll();
    const interval = setInterval(poll, 10000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [token, can]);

  const groups = useMemo(() => NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => item.id === "overview" || can(item.id)),
  })).filter((group) => group.items.length), [can]);

  const badgeCounts = { panics: panicCount, "flight-issues": flightIssueCount };
  const roleLabel = access?.isOwner ? "Owner" : (user?.role || "Staff");

  return (
    <>
      {open ? <div className="sidebar-backdrop" onClick={onClose} /> : null}
      <aside className={`sidebar ${open ? "sidebar-open" : ""} ${collapsed ? "sidebar-collapsed" : ""}`}>
        <div className="sidebar-brand-row">
          <div className="sidebar-brand-copy">
            <img src={wordmarkLight} alt="RideArrivo" className="brand-logo" />
            <div className="brand-sub">ARRIVOOPS</div>
          </div>
          <button type="button" className="sidebar-collapse" onClick={() => setCollapsed?.(!collapsed)} aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}>
            {collapsed ? "›" : "‹"}
          </button>
        </div>

        <div className="sidebar-status">
          <span className="ops-live-dot" />
          <span className="sidebar-status-copy"><strong>Console online</strong><small>{roleLabel}</small></span>
        </div>

        <nav className="sidebar-nav">
          {groups.map((group) => (
            <div className="nav-group" key={group.label}>
              <div className="nav-group-label">{group.label}</div>
              {group.items.map((item) => {
                const count = badgeCounts[item.id] || 0;
                return (
                  <button
                    key={item.id}
                    className={`nav-item ${page === item.id ? "active" : ""}`}
                    onClick={() => { setPage(item.id); onClose?.(); }}
                    title={collapsed ? item.label : undefined}
                    style={item.danger && count > 0 && page !== item.id ? { color: "var(--coral)" } : undefined}
                  >
                    <span className="nav-icon"><OpsIcon name={item.icon} size={17} /></span>
                    <span className="nav-label">{item.label}</span>
                    {item.badgeColor && count > 0 ? <span className="nav-badge" style={{ background: item.badgeColor }}>{count}</span> : null}
                  </button>
                );
              })}
            </div>
          ))}
          {access?.isOwner || user?.role === "admin" ? (
            <div className="nav-group">
              <div className="nav-group-label">Web side</div>
              <a className="nav-item" href={ENGINE_OPS_URL} target="_blank" rel="noopener noreferrer" title={collapsed ? "Engine Ops" : "Web journeys, driver documents, WhatsApp. Opens in a new tab."}>
                <span className="nav-icon"><OpsIcon name="layers" size={17} /></span><span className="nav-label">Engine Ops</span>
              </a>
            </div>
          ) : null}
          {access?.canSeeTeam ? (
            <div className="nav-group">
              <div className="nav-group-label">Administration</div>
              <button className={`nav-item ${page === "team" ? "active" : ""}`} onClick={() => { setPage("team"); onClose?.(); }} title={collapsed ? "Team & Access" : undefined}>
                <span className="nav-icon"><OpsIcon name="lock" size={17} /></span><span className="nav-label">Team & Access</span>
              </button>
            </div>
          ) : null}
        </nav>

        <div className="sidebar-user">
          <div className="sidebar-avatar">{String(user?.name || user?.email || "A").trim().slice(0, 1).toUpperCase()}</div>
          <div className="sidebar-user-copy"><strong>{user?.name || "Arrivo staff"}</strong><span>{roleLabel}</span></div>
          <button className="logout" onClick={logout} title="Log out">⏻</button>
        </div>
      </aside>
    </>
  );
}
