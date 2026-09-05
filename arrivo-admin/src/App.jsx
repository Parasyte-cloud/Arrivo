import { Suspense, lazy, useCallback, useEffect, useState } from "react";
import { AuthProvider, useAuth } from "./AuthContext";
import { StreamClientProvider } from "./StreamClientContext";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { LoginPage } from "./pages/LoginPage";
import { Sidebar } from "./components/Sidebar";
import wordmarkLight from "./assets/wordmark-light.png";

// Lazy-loaded per page instead of one ~1MB upfront bundle — Leaflet
// (LiveMapPage) and the Stream Video SDK (pulled in by RidersPage/
// DriversPage's CallButton) are the two biggest contributors, and most
// admin sessions only ever touch a handful of these pages. Splitting
// means the first paint only downloads whichever page is actually
// opened, not all ten. LoginPage stays a normal import since it's the
// very first thing an unauthenticated visitor needs — no point deferring
// something that's needed immediately anyway.
const PanicsPage = lazy(() => import("./pages/PanicsPage").then((m) => ({ default: m.PanicsPage })));
const RidersPage = lazy(() => import("./pages/RidersPage").then((m) => ({ default: m.RidersPage })));
const DriversPage = lazy(() => import("./pages/DriversPage").then((m) => ({ default: m.DriversPage })));
const RidesPage = lazy(() => import("./pages/RidesPage").then((m) => ({ default: m.RidesPage })));
const LiveMapPage = lazy(() => import("./pages/LiveMapPage").then((m) => ({ default: m.LiveMapPage })));
const AnalyticsPage = lazy(() => import("./pages/AnalyticsPage").then((m) => ({ default: m.AnalyticsPage })));
const MembershipsPage = lazy(() => import("./pages/MembershipsPage").then((m) => ({ default: m.MembershipsPage })));
const WalletPage = lazy(() => import("./pages/WalletPage").then((m) => ({ default: m.WalletPage })));
const FlightIssuesPage = lazy(() => import("./pages/FlightIssuesPage").then((m) => ({ default: m.FlightIssuesPage })));
const VehiclesPage = lazy(() => import("./pages/VehiclesPage").then((m) => ({ default: m.VehiclesPage })));
const SupportPage = lazy(() => import("./pages/SupportPage").then((m) => ({ default: m.SupportPage })));

// Every page key Dashboard actually knows how to render — used both to
// validate an incoming URL hash (so a stale/garbage/mistyped link can
// never leave the app on a blank page) and as the single source of truth
// for what "a valid page" means.
const PAGES = [
  "panics", "riders", "drivers", "rides", "support", "flight-issues",
  "vehicles", "memberships", "wallet", "live-map", "analytics",
];

const OPERATIONS_PAGES = [
  "panics",
  "drivers",
  "rides",
  "flight-issues",
  "vehicles",
  "live-map",
  "analytics",
];


function pageFromHash(allowedPages = PAGES) {
  const hash = window.location.hash.replace(/^#\/?/, "");
  return allowedPages.includes(hash) ? hash : "panics";
}

function Dashboard() {
  const { isOperations } = useAuth();
  const allowedPages = isOperations
    ? OPERATIONS_PAGES
    : PAGES;

  // Default to Panic Alerts on login — the safety-critical view should be
  // the first thing an ops person sees, not something they have to
  // remember to check. Reading from the URL hash first (falling back to
  // "panics") means a refresh, a bookmark, or a link shared with a
  // teammate all land on the actual page intended, not always the
  // default — and the hash sync below keeps the two in sync from here on.
  const [page, setPageState] = useState(() => pageFromHash(allowedPages));

  const setPage = useCallback((next) => {
    if (!allowedPages.includes(next)) return;

    setPageState(next);

    if (
      window.location.hash.replace(/^#\/?/, "")
      !== next
    ) {
      window.location.hash = `/${next}`;
    }
  }, [allowedPages]);

  // Browser back/forward changes the hash without touching React state on
  // its own — this is what makes those buttons actually navigate between
  // admin pages instead of doing nothing (or leaving the visible page out
  // of sync with the URL).
  useEffect(() => {
    const onHashChange = () => {
      const raw =
        window.location.hash.replace(/^#\/?/, "");

      const next =
        pageFromHash(allowedPages);

      setPageState(next);

      if (
        raw
        && !allowedPages.includes(raw)
      ) {
        window.location.hash = `/${next}`;
      }
    };

    window.addEventListener(
      "hashchange",
      onHashChange
    );

    return () =>
      window.removeEventListener(
        "hashchange",
        onHashChange
      );
  }, [allowedPages]);

  // First render: if there was no hash at all (a fresh login, not a
  // deep link), write one so the address bar reflects reality from the
  // start rather than only after the first nav click.
  useEffect(() => {
    const raw =
      window.location.hash.replace(/^#\/?/, "");

    if (
      !raw
      || !allowedPages.includes(raw)
    ) {
      window.location.hash = `/${page}`;
    }
  }, [allowedPages, page]);
  // Sidebar is always visible on desktop; on narrow (phone) screens it
  // becomes an off-canvas drawer toggled by the hamburger button below —
  // see the .sidebar / .mobile-topbar rules in styles.css for the
  // breakpoint (860px) that switches between the two layouts.
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div className="app-shell">
      <div className="mobile-topbar">
        <button className="hamburger" onClick={() => setSidebarOpen(true)} aria-label="Open menu">☰</button>
        <img src={wordmarkLight} alt="RideArrivo" className="mobile-brand-logo" />
      </div>
      <Sidebar page={page} setPage={setPage} open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <main className="main">
        <ErrorBoundary resetKey={page}>
          <Suspense fallback={<div className="empty-state">Loading…</div>}>
            {page === "panics" && <PanicsPage />}
            {page === "riders" && <RidersPage />}
            {page === "drivers" && <DriversPage />}
            {page === "rides" && <RidesPage />}
            {page === "flight-issues" && <FlightIssuesPage />}
            {page === "vehicles" && <VehiclesPage />}
            {page === "memberships" && <MembershipsPage />}
            {page === "wallet" && <WalletPage />}
            {page === "live-map" && <LiveMapPage />}
            {page === "support" && <SupportPage />}
            {page === "analytics" && <AnalyticsPage />}
          </Suspense>
        </ErrorBoundary>
      </main>
    </div>
  );
}

function Root() {
  const {
    isAuthenticated,
    initializing,
    isOperations,
  } = useAuth();

  if (initializing) {
    return (
      <div className="login-screen">
        <div style={{ color: "var(--text-muted)" }}>
          Loading...
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <LoginPage />;
  }

  if (isOperations) {
    return <Dashboard />;
  }

  return (
    <StreamClientProvider>
      <Dashboard />
    </StreamClientProvider>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <Root />
    </AuthProvider>
  );
}
