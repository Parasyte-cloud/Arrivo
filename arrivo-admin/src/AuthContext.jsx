import React, { createContext, useContext, useEffect, useState } from "react";
import * as api from "./api";

const TOKEN_KEY = "arrivo_admin_token";
const AuthContext = createContext(null);

// Two roles can use this dashboard: "admin" (full access) and "support"
// (read-only — for customer support staff who need visibility without the
// ability to verify drivers, resolve panics, or change ride status).
// IMPORTANT: this only controls what buttons render in this app. The real
// enforcement has to happen on the backend — every PATCH/POST admin
// endpoint must independently check the JWT's role and reject support-role
// tokens, since anyone can bypass frontend-only restrictions via devtools
// or a direct API call. Treat this as a UX convenience, not a security
// boundary, until that server-side check exists.
const ALLOWED_ROLES = ["admin", "support"];

export function AuthProvider({ children }) {
  const [token, setToken] = useState(null);
  const [user, setUser] = useState(null);
  const [initializing, setInitializing] = useState(true);

  useEffect(() => {
    (async () => {
      const saved = localStorage.getItem(TOKEN_KEY);
      if (saved) {
        try {
          const { user: me } = await api.getMe(saved);
          if (!ALLOWED_ROLES.includes(me.role)) throw new Error("Not an admin or support account");
          setToken(saved);
          setUser(me);
        } catch {
          localStorage.removeItem(TOKEN_KEY);
        }
      }
      setInitializing(false);
    })();
  }, []);

  const login = async (email, password) => {
    const data = await api.login(email, password);
    if (!ALLOWED_ROLES.includes(data.user.role)) {
      throw new Error("This account isn't an admin or support account.");
    }
    localStorage.setItem(TOKEN_KEY, data.token);
    setToken(data.token);
    setUser(data.user);
  };

  const logout = () => {
    localStorage.removeItem(TOKEN_KEY);
    setToken(null);
    setUser(null);
  };

  // api.js's central request() dispatches this whenever any endpoint
  // responds 401 — an expired/invalid token. Several pollers here (e.g.
  // Sidebar.jsx's panic/flight-issue poll) explicitly swallow their own
  // errors, so without this a stale session would just fail silently and
  // repeatedly forever instead of kicking the admin back to the login
  // screen.
  useEffect(() => {
    const handleExpired = () => logout();
    window.addEventListener("auth:expired", handleExpired);
    return () => window.removeEventListener("auth:expired", handleExpired);
  }, []);

  // The `storage` event only fires in OTHER tabs/windows, never the one
  // that made the change — exactly what's needed to keep multiple open
  // admin panel tabs in sync. Without this, logging out in one tab still
  // leaves every other tab fully "logged in" (still polling, still able
  // to submit mutating actions) until each one independently hits a 401.
  useEffect(() => {
    const handleStorage = (event) => {
      if (event.key !== TOKEN_KEY) return;
      if (!event.newValue) {
        // Cleared in another tab — a real logout there, or that tab's
        // session expired. Either way this tab shouldn't stay "logged in".
        setToken(null);
        setUser(null);
        return;
      }
      if (event.newValue !== token) {
        // A login happened in another tab (possibly a different account
        // entirely) — reload rather than trying to patch this tab's state
        // in place, since every page here holds its own fetched data that
        // could otherwise end up mixing two different sessions' results.
        window.location.reload();
      }
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, [token]);

  const isReadOnly = user?.role === "support";

  return (
    <AuthContext.Provider value={{ token, user, initializing, login, logout, isAuthenticated: !!token, isReadOnly }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside an AuthProvider");
  return ctx;
}
