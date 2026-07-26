import * as SecureStore from "expo-secure-store";
import { API_BASE_URL } from "../services/config";

// Must match context/AuthContext.js's own TOKEN_KEY exactly — this file
// deliberately does NOT import AuthContext, since it's called from
// utils/setPushConfig.js's createStreamVideoClient callback, which runs
// outside the React tree entirely (the app can be launched cold, from a
// killed state, by an incoming-call push notification, before any React
// component — including AuthProvider — has ever mounted). Reading the same
// SecureStore key AuthContext already persists to is simpler and more
// reliable here than trying to introduce a second, separately-synced
// storage mechanism just for this one background path.
const TOKEN_KEY = "arrivo_token";

// Returns { apiKey, userId, videoToken, chatToken } or null if there's no
// signed-in session yet (e.g. a push arriving after logout, or before
// first login).
export async function fetchStreamCallAuth() {
  const jwt = await SecureStore.getItemAsync(TOKEN_KEY);
  if (!jwt) return null;

  const res = await fetch(`${API_BASE_URL}/api/calls/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
