import { API_BASE_URL } from "./config";

async function request(path, options = {}) {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

function authed(token, options = {}) {
  return {
    ...options,
    headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` },
  };
}

// Auth
export function signup(payload) {
  return request("/api/auth/signup", { method: "POST", body: JSON.stringify(payload) });
}
export function login(payload) {
  return request("/api/auth/login", { method: "POST", body: JSON.stringify(payload) });
}
export function getMe(token) {
  return request("/api/auth/me", authed(token));
}

// Driver profile
export function saveDriverProfile(token, payload) {
  return request("/api/drivers/profile", authed(token, { method: "POST", body: JSON.stringify(payload) }));
}
export function getDriverProfile(token) {
  return request("/api/drivers/me", authed(token));
}
export function setOnlineStatus(token, isOnline) {
  return request("/api/drivers/status", authed(token, { method: "PATCH", body: JSON.stringify({ isOnline }) }));
}
export function updateLocation(token, lat, lng) {
  return request("/api/drivers/location", authed(token, { method: "PATCH", body: JSON.stringify({ lat, lng }) }));
}
export function getEarnings(token) {
  return request("/api/drivers/earnings", authed(token));
}

// Rides
export function getAvailableRides(token) {
  return request("/api/rides/available", authed(token));
}
export function acceptRide(token, rideId) {
  return request(`/api/rides/${rideId}/accept`, authed(token, { method: "POST" }));
}
export function updateRideStatus(token, rideId, status) {
  return request(`/api/rides/${rideId}/status`, authed(token, { method: "PATCH", body: JSON.stringify({ status }) }));
}
export function getMyDriverRides(token) {
  return request("/api/rides/driver/mine", authed(token));
}
export function triggerPanic(token, rideId, note) {
  return request(`/api/rides/${rideId}/panic`, authed(token, { method: "POST", body: JSON.stringify({ note }) }));
}
// One-way activation, no deactivate call — matches ridearrivo.com. Panic
// (above) already activates this automatically server-side too.
export function activateListeningDevice(token, rideId) {
  return request(`/api/rides/${rideId}/listening-device`, authed(token, { method: "POST" }));
}
