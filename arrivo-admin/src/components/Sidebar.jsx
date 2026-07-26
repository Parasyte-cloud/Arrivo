import { useEffect, useState } from "react";
import { useAuth } from "../AuthContext";
import * as api from "../api";
import wordmarkLight from "../assets/wordmark-light.png";

const NAV_ITEMS = [
  { id: "panics", label: "Panic Alerts", icon: "🔔", danger: true, badgeColor: "var(--coral)" },
  { id: "riders", label: "Riders", icon: "👥" },
  { id: "drivers", label: "Drivers", icon: "🚘" },
  { id: "rides", label: "Rides", icon: "🚗" },
  { id: "flight-issues", label: "Flight Issues", icon: "✈️", badgeColor: "var(--amber)" },
  { id: "vehicles", label: "Vehicles", icon: "🚙" },
  { id: "memberships", label: "Memberships", icon: "🎫" },
  { id: "wallet", label: "Wallet", icon: "👛" },
  { id: "live-map", label: "Live Map", icon: "📍" },
  { id: "analytics", label: "Analytics", icon: "📊" },
];

export function Sidebar({ page, setPage, open, onClose }) {
  const { user, token, logout, isReadOnly } = useAuth();
  const [panicCount, setPanicCount] = useState(0);
  const [flightIssueCount, setFlightIssueCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    function poll() {
      api.getPanics(token)
        .then(({ panics }) => { if (!cancelled) setPanicCount(panics.length); })
        .catch(() => {});
      api.getFlightIssues(token)
        .then(({ flightIssues }) => { if (!cancelled) setFlightIssueCount(flightIssues.length); })
        .catch(() => {});
    }
    poll();
    const interval = setInterval(poll, 10000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [token]);

  const badgeCounts = { panics: panicCount, "flight-issues": flightIssueCount };

  return (
    <>
      {open ? <div className="sidebar-backdrop" onClick={onClose} /> : null}
      <aside className={`sidebar ${open ? "sidebar-open" : ""}`}>
      <img src={wordmarkLight} alt="RideArrivo" className="brand-logo" />
      <div className="brand-sub">OPS CONSOLE</div>
      {isReadOnly ? (
        <div style={{
          margin: "0 0 16px", padding: "4px 10px", background: "var(--glass-strong)",
          borderRadius: 999, fontSize: 10.5, fontWeight: 700, color: "var(--amber)",
          textAlign: "center", letterSpacing: "0.04em",
        }}>
          READ-ONLY · SUPPORT
        </div>
      ) : null}

      <nav>
        {NAV_ITEMS.map((item) => {
          const count = badgeCounts[item.id] || 0;
          return (
            <button
              key={item.id}
              className={`nav-item ${page === item.id ? "active" : ""}`}
              onClick={() => { setPage(item.id); onClose && onClose(); }}
              style={item.danger && count > 0 && page !== item.id ? { color: "var(--coral)" } : undefined}
            >
              <span className="nav-icon">{item.icon}</span>
              {item.label}
              {item.badgeColor && count > 0 ? (
                <span className="nav-badge" style={{ background: item.badgeColor }}>
                  {count}
                </span>
              ) : null}
            </button>
          );
        })}
      </nav>

      <div style={{ fontSize: 11.5, color: "var(--text-muted)", padding: "10px 12px 4px" }}>
        {user?.name}
      </div>
      <button className="logout" onClick={logout}><span className="nav-icon">⏻</span>Log out</button>
      </aside>
    </>
  );
}
