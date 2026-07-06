import React, { createContext, useContext, useEffect, useState } from "react";
import * as api from "./api";

const TOKEN_KEY = "arrivo_admin_token";
const AuthContext = createContext(null);

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
          if (me.role !== "admin") throw new Error("Not an admin account");
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
    if (data.user.role !== "admin") {
      throw new Error("This account isn't an admin account.");
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

  return (
    <AuthContext.Provider value={{ token, user, initializing, login, logout, isAuthenticated: !!token }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside an AuthProvider");
  return ctx;
}
