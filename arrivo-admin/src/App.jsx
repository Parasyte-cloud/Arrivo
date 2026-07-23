import { useState } from "react";
import { AuthProvider, useAuth } from "./AuthContext";
import { LoginPage } from "./pages/LoginPage";
import { PanicsPage } from "./pages/PanicsPage";
import { RidersPage } from "./pages/RidersPage";
import { DriversPage } from "./pages/DriversPage";
import { RidesPage } from "./pages/RidesPage";
import { LiveMapPage } from "./pages/LiveMapPage";
import { AnalyticsPage } from "./pages/AnalyticsPage";
import { MembershipsPage } from "./pages/MembershipsPage";
import { WalletPage } from "./pages/WalletPage";
import { FlightIssuesPage } from "./pages/FlightIssuesPage";
import { VehiclesPage } from "./pages/VehiclesPage";
import { Sidebar } from "./components/Sidebar";

function Dashboard() {
  // Default to Panic Alerts on login — the safety-critical view should be
  // the first thing an ops person sees, not something they have to
  // remember to check.
  const [page, setPage] = useState("panics");
  // Sidebar is always visible on desktop; on narrow (phone) screens it
  // becomes an off-canvas drawer toggled by the hamburger button below —
  // see the .sidebar / .mobile-topbar rules in styles.css for the
  // breakpoint (860px) that switches between the two layouts.
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div className="app-shell">
      <div className="mobile-topbar">
        <button className="hamburger" onClick={() => setSidebarOpen(true)} aria-label="Open menu">☰</button>
        <span className="mobile-brand">RideArrivo</span>
      </div>
      <Sidebar page={page} setPage={setPage} open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <main className="main">
        {page === "panics" && <PanicsPage />}
        {page === "riders" && <RidersPage />}
        {page === "drivers" && <DriversPage />}
        {page === "rides" && <RidesPage />}
        {page === "flight-issues" && <FlightIssuesPage />}
        {page === "vehicles" && <VehiclesPage />}
        {page === "memberships" && <MembershipsPage />}
        {page === "wallet" && <WalletPage />}
        {page === "live-map" && <LiveMapPage />}
        {page === "analytics" && <AnalyticsPage />}
      </main>
    </div>
  );
}

function Root() {
  const { isAuthenticated, initializing } = useAuth();

  if (initializing) {
    return <div className="login-screen"><div style={{ color: "#fff" }}>Loading…</div></div>;
  }

  return isAuthenticated ? <Dashboard /> : <LoginPage />;
}

export default function App() {
  return (
    <AuthProvider>
      <Root />
    </AuthProvider>
  );
}
