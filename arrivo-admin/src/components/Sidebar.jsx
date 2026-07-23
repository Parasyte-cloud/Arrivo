import { useEffect, useState } from "react";
import { useAuth } from "../AuthContext";
import * as api from "../api";

const NAV_ITEMS = [
  { id: "panics", label: "Panic Alerts", danger: true, badgeColor: "var(--coral)" },
  { id: "riders", label: "Riders" },
  { id: "drivers", label: "Drivers" },
  { id: "rides", label: "Rides" },
  { id: "flight-issues", label: "Flight Issues", badgeColor: "var(--amber)" },
  { id: "vehicles", label: "Vehicles" },
  { id: "memberships", label: "Memberships" },
  { id: "wallet", label: "Wallet" },
  { id: "live-map", label: "Live Map" },
  { id: "analytics", label: "Analytics" },
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
      <div className="brand">RideArrivo</div>
      <div className="brand-sub">OPS CONSOLE</div>
      {isReadOnly ? (
        <div style={{
          margin: "8px 14px 4px", padding: "4px 10px", background: "rgba(255,255,255,0.1)",
          borderRadius: 999, fontSize: 10.5, fontWeight: 700, color: "#ffb84d",
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
              style={item.danger && count > 0 ? { color: "#ff8a75" } : undefined}
            >
              {item.label}
              {item.badgeColor && count > 0 ? (
                <span
                  style={{
                    marginLeft: 8,
                    background: item.badgeColor,
                    color: "#fff",
                    borderRadius: 999,
                    fontSize: 10.5,
                    fontWeight: 700,
                    padding: "1px 7px",
                  }}
                >
                  {count}
                </span>
              ) : null}
            </button>
          );
        })}
      </nav>

      <div style={{ fontSize: 11.5, color: "#8a8ab0", padding: "0 14px", marginBottom: 8 }}>
        {user?.name}
      </div>
      <button className="logout" onClick={logout}>Log out</button>
      </aside>
    </>
  );
}
