import React, { createContext, useContext, useEffect, useState } from "react";
import * as api from "./api";

const ARRIVOOPS_SURFACE = new URLSearchParams(
  window.location.search
).get("surface");

const IS_OPERATIONS_SURFACE =
  ARRIVOOPS_SURFACE === "operations";

const TOKEN_KEY = IS_OPERATIONS_SURFACE
  ? "arrivo_operations_token"
  : "arrivo_admin_token";
const AuthContext = createContext(null);

// ArrivoOps staff roles:
// - admin: full console access
// - support: existing read-only support access
// - operations: strict read-only operational access
//
// Frontend restrictions are UX controls only. The backend remains the
// security boundary: operationsReadOnly.js denies Operations by default
// and permits only explicitly approved read-only operational GET routes.
const ALLOWED_ROLES = IS_OPERATIONS_SURFACE
  ? ["operations"]
  : ["admin", "support", "operations"];

const ROLE_ERROR = IS_OPERATIONS_SURFACE
  ? "This ArrivoOps surface requires an Operations account."
  : "This account isn't an ArrivoOps staff account.";

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
          if (!ALLOWED_ROLES.includes(me.role)) throw new Error(ROLE_ERROR);
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
      throw new Error(ROLE_ERROR);
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

  const isOperations = user?.role === "operations";
  const isReadOnly = user?.role === "support" || isOperations;

  return (
    <AuthContext.Provider value={{ token, user, initializing, login, logout, isAuthenticated: !!token, isReadOnly, isOperations }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside an AuthProvider");
  return ctx;
}
