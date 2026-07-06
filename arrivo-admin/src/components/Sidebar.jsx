import { useAuth } from "../AuthContext";

const NAV_ITEMS = [
  { id: "drivers", label: "Drivers" },
  { id: "rides", label: "Rides" },
  { id: "analytics", label: "Analytics" },
];

export function Sidebar({ page, setPage }) {
  const { user, logout } = useAuth();

  return (
    <aside className="sidebar">
      <div className="brand">arrivo</div>
      <div className="brand-sub">OPS CONSOLE</div>

      <nav>
        {NAV_ITEMS.map((item) => (
          <button
            key={item.id}
            className={`nav-item ${page === item.id ? "active" : ""}`}
            onClick={() => setPage(item.id)}
          >
            {item.label}
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
