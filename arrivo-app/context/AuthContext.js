import React, { createContext, useContext, useEffect, useState } from "react";
import * as SecureStore from "expo-secure-store";
import { API_BASE_URL } from "../services/config";
import { setAppLanguage } from "../i18n";

const TOKEN_KEY = "arrivo_token";
const AuthContext = createContext(null);

async function request(path, options = {}) {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export function AuthProvider({ children }) {
  const [token, setToken] = useState(null);
  const [user, setUser] = useState(null);
  const [initializing, setInitializing] = useState(true);

  // On app launch, check if we already have a saved token and restore the session.
  useEffect(() => {
    (async () => {
      try {
        const saved = await SecureStore.getItemAsync(TOKEN_KEY);
        if (saved) {
          const { user: me } = await request("/api/auth/me", {
            headers: { Authorization: `Bearer ${saved}` },
          });
          setToken(saved);
          setUser(me);
          setAppLanguage(me.preferred_language);
        }
      } catch (e) {
        // Saved token was invalid/expired — clear it silently and fall back to login.
        await SecureStore.deleteItemAsync(TOKEN_KEY);
      } finally {
        setInitializing(false);
      }
    })();
  }, []);

  const signup = async ({ firstName, lastName, email, passportNumber, phone, password, confirmPassword, agreedToTerms, preferredLanguage, whatsappNumber, countryOfResidence, avatarDataUrl }) => {
    const data = await request("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ firstName, lastName, email, passportNumber, phone, password, confirmPassword, agreedToTerms, preferredLanguage, whatsappNumber, countryOfResidence, avatarDataUrl }),
    });
    await SecureStore.setItemAsync(TOKEN_KEY, data.token);
    setToken(data.token);
    setUser(data.user);
    setAppLanguage(data.user.preferred_language);
    return data.user;
  };

  const login = async ({ email, password }) => {
    const data = await request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    await SecureStore.setItemAsync(TOKEN_KEY, data.token);
    setToken(data.token);
    setUser(data.user);
    setAppLanguage(data.user.preferred_language);
    return data.user;
  };

  const logout = async () => {
    await SecureStore.deleteItemAsync(TOKEN_KEY);
    setToken(null);
    setUser(null);
  };

  const updateProfile = async (updates) => {
    const data = await request("/api/auth/me", {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify(updates),
    });
    setUser(data.user);
    if (updates.preferredLanguage) setAppLanguage(updates.preferredLanguage);
    return data.user;
  };

  // Moves the rider from 'unverified'/'rejected' straight to 'pending' —
  // see routes/auth.js POST /submit-id-verification. Same setUser(data.user)
  // pattern as updateProfile above, so VerifyIdScreen/ProfileScreen see the
  // new status immediately without needing a fresh /me fetch or re-login.
  const submitIdVerification = async (idDocumentDataUrl) => {
    const data = await request("/api/auth/submit-id-verification", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ idDocumentDataUrl }),
    });
    setUser(data.user);
    return data.user;
  };

  return (
    <AuthContext.Provider
      value={{ token, user, initializing, signup, login, logout, updateProfile, submitIdVerification, isAuthenticated: !!token }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside an AuthProvider");
  return ctx;
}
