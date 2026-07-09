import React, { createContext, useContext, useEffect, useState } from "react";
import * as SecureStore from "expo-secure-store";
import * as api from "../services/api";

const TOKEN_KEY = "arrivo_driver_token";
const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [token, setToken] = useState(null);
  const [user, setUser] = useState(null);
  const [initializing, setInitializing] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const saved = await SecureStore.getItemAsync(TOKEN_KEY);
        if (saved) {
          const { user: me } = await api.getMe(saved);
          setToken(saved);
          setUser(me);
        }
      } catch (e) {
        await SecureStore.deleteItemAsync(TOKEN_KEY);
      } finally {
        setInitializing(false);
      }
    })();
  }, []);

  const signup = async ({ name, email, phone, password }) => {
    // Always signs up as role "driver" — this is the driver app, not the rider app.
    const data = await api.signup({ name, email, phone, password, role: "driver" });
    await SecureStore.setItemAsync(TOKEN_KEY, data.token);
    setToken(data.token);
    setUser(data.user);
    return data.user;
  };

  const login = async ({ email, password }) => {
    const data = await api.login({ email, password });
    if (data.user.role !== "driver") {
      throw new Error("This account isn't registered as a driver. Use the Arrivo rider app instead.");
    }
    await SecureStore.setItemAsync(TOKEN_KEY, data.token);
    setToken(data.token);
    setUser(data.user);
    return data.user;
  };

  const logout = async () => {
    await SecureStore.deleteItemAsync(TOKEN_KEY);
    setToken(null);
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ token, user, initializing, signup, login, logout, isAuthenticated: !!token }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside an AuthProvider");
  return ctx;
}
