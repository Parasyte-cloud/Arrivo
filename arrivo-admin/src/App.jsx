import { useState } from "react";
import { AuthProvider, useAuth } from "./AuthContext";
import { LoginPage } from "./pages/LoginPage";
import { DriversPage } from "./pages/DriversPage";
import { RidesPage } from "./pages/RidesPage";
import { AnalyticsPage } from "./pages/AnalyticsPage";
import { Sidebar } from "./components/Sidebar";

function Dashboard() {
  const [page, setPage] = useState("drivers");

  return (
    <div className="app-shell">
      <Sidebar page={page} setPage={setPage} />
      <main className="main">
        {page === "drivers" && <DriversPage />}
        {page === "rides" && <RidesPage />}
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
