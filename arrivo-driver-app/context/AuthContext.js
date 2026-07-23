import React, { createContext, useContext, useEffect, useState } from "react";
import * as SecureStore from "expo-secure-store";
import * as Location from "expo-location";
import * as api from "../services/api";
import { LOCATION_TASK_NAME } from "../tasks/backgroundLocationTask";

const TOKEN_KEY = "arrivo_driver_token";
// Caches the last successfully-fetched profile so a cold start with no
// signal (very real for a driver waiting at the airport) can still let them
// into the app using their last-known profile, instead of stranding them on
// Login. Previously a non-401 getMe() failure correctly avoided deleting the
// token, but never actually granted access either — token/user both stayed
// null, so isAuthenticated was false regardless, and the driver was dropped
// on Login anyway despite the comment's stated intent.
const USER_CACHE_KEY = "arrivo_driver_user_cache";

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
          // Refresh the cache on every successful cold-start fetch so the
          // fallback below is never more stale than the driver's last
          // successful launch.
          await SecureStore.setItemAsync(USER_CACHE_KEY, JSON.stringify(me));
        }
      } catch (e) {
        // Only clear a stored token when the server actually says it's
        // invalid/expired (401) — a transient network failure (very real
        // for a driver waiting at the airport with spotty signal) used to
        // wipe a perfectly good session and force a re-login for no reason.
        if (e?.status === 401) {
          await SecureStore.deleteItemAsync(TOKEN_KEY);
          await SecureStore.deleteItemAsync(USER_CACHE_KEY);
        } else {
          // Not a rejected token — just couldn't reach the server. Admit the
          // driver using the last profile we successfully fetched, so they
          // aren't stranded on Login. Every real API call still carries the
          // token and will get its own 401 if the token has actually gone
          // bad in the meantime; this only smooths over the cold-start check.
          try {
            const saved = await SecureStore.getItemAsync(TOKEN_KEY);
            const cachedUserRaw = await SecureStore.getItemAsync(USER_CACHE_KEY);
            if (saved && cachedUserRaw) {
              setToken(saved);
              setUser(JSON.parse(cachedUserRaw));
            }
          } catch {
            // Cache unreadable/corrupt — fall through to the Login screen,
            // same as before this fix existed.
          }
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
    await SecureStore.setItemAsync(USER_CACHE_KEY, JSON.stringify(data.user));
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
    await SecureStore.setItemAsync(USER_CACHE_KEY, JSON.stringify(data.user));
    setToken(data.token);
    setUser(data.user);
    return data.user;
  };

  const loginWithGoogle = async ({ idToken, agreedToTerms }) => {
    const data = await api.loginWithGoogle({ idToken, agreedToTerms });
    await SecureStore.setItemAsync(TOKEN_KEY, data.token);
    await SecureStore.setItemAsync(USER_CACHE_KEY, JSON.stringify(data.user));
    setToken(data.token);
    setUser(data.user);
    return data;
  };

  const loginWithApple = async ({ identityToken, fullName, agreedToTerms }) => {
    const data = await api.loginWithApple({ identityToken, fullName, agreedToTerms });
    await SecureStore.setItemAsync(TOKEN_KEY, data.token);
    await SecureStore.setItemAsync(USER_CACHE_KEY, JSON.stringify(data.user));
    setToken(data.token);
    setUser(data.user);
    return data;
  };

  const logout = async () => {
    await stopBackgroundLocation();
    await SecureStore.deleteItemAsync(TOKEN_KEY);
    await SecureStore.deleteItemAsync(USER_CACHE_KEY);
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
