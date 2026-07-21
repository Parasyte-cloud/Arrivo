import { useEffect, useState } from "react";
import { useAuth } from "../AuthContext";
import * as api from "../api";

const NAV_ITEMS = [
  { id: "panics", label: "Panic Alerts", danger: true },
  { id: "riders", label: "Riders" },
  { id: "drivers", label: "Drivers" },
  { id: "rides", label: "Rides" },
  { id: "memberships", label: "Memberships" },
  { id: "wallet", label: "Wallet" },
  { id: "live-map", label: "Live Map" },
  { id: "analytics", label: "Analytics" },
];

export function Sidebar({ page, setPage }) {
  const { user, token, logout, isReadOnly } = useAuth();
  const [panicCount, setPanicCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    function poll() {
      api.getPanics(token)
        .then(({ panics }) => { if (!cancelled) setPanicCount(panics.length); })
        .catch(() => {});
    }
    poll();
    const interval = setInterval(poll, 10000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [token]);

  return (
    <aside className="sidebar">
      <div className="brand">arrivo</div>
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
        {NAV_ITEMS.map((item) => (
          <button
            key={item.id}
            className={`nav-item ${page === item.id ? "active" : ""}`}
            onClick={() => setPage(item.id)}
            style={item.danger && panicCount > 0 ? { color: "#ff8a75" } : undefined}
          >
            {item.label}
            {item.id === "panics" && panicCount > 0 ? (
              <span
                style={{
                  marginLeft: 8,
                  background: "var(--coral)",
                  color: "#fff",
                  borderRadius: 999,
                  fontSize: 10.5,
                  fontWeight: 700,
                  padding: "1px 7px",
                }}
              >
                {panicCount}
              </span>
            ) : null}
          </button>
        ))}
      </nav>

      <div style={{ fontSize: 11.5, color: "#8a8ab0", padding: "0 14px", marginBottom: 8 }}>
        {user?.name}
      </div>
      <button className="logout" onClick={logout}>Log out</button>
    </aside>
  );
}
