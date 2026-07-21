import React, { createContext, useContext, useEffect, useState } from "react";
import * as SecureStore from "expo-secure-store";
import * as Location from "expo-location";
import * as api from "../services/api";
import { LOCATION_TASK_NAME } from "../tasks/backgroundLocationTask";

const TOKEN_KEY = "arrivo_driver_token";

// Stops the background location task (see hooks/useLocationReporting.js)
// if it's running. Without this, logging out would leave a background
// task silently reporting GPS forever — updateLocation would just start
// failing with 401s once the token is gone, but the OS-level location
// tracking (and its persistent notification on Android) would keep
// running until the app was force-quit.
async function stopBackgroundLocation() {
  try {
    const started = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME);
    if (started) await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
  } catch {
    // Task was never started this session — nothing to stop.
  }
}
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
        // Only clear a stored token when the server actually says it's
        // invalid/expired (401) — a transient network failure (very real
        // for a driver waiting at the airport with spotty signal) used to
        // wipe a perfectly good session and force a re-login for no reason.
        if (e?.status === 401) {
          await SecureStore.deleteItemAsync(TOKEN_KEY);
        }
      } finally {
        setInitializing(false);
      }
    })();
  }, []);

  const signup = async ({ firstName, lastName, email, phone, password, agreedToTerms }) => {
    // Always signs up as role "driver" — this is the driver app, not the rider app.
    // The backend's /api/auth/signup expects firstName/lastName (it derives the
    // combined `name` server-side) and requires agreedToTerms to be true.
    const data = await api.signup({ firstName, lastName, email, phone, password, agreedToTerms, role: "driver" });
    await SecureStore.setItemAsync(TOKEN_KEY, data.token);
    setToken(data.token);
    setUser(data.user);
    return data.user;
  };

  const login = async ({ email, password }) => {
    const data = await api.login({ email, password });
    if (data.user.role !== "driver") {
      throw new Error("This account isn't registered as a driver. Use the RideArrivo rider app instead.");
    }
    await SecureStore.setItemAsync(TOKEN_KEY, data.token);
    setToken(data.token);
    setUser(data.user);
    return data.user;
  };

  const logout = async () => {
    await stopBackgroundLocation();
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
