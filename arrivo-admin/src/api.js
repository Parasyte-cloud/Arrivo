// Vite exposes env vars prefixed with VITE_ on import.meta.env.
// Set VITE_API_BASE_URL in a .env file — see .env.example.
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "http://localhost:4000";

async function request(path, token, options = {}) {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export const login = (email, password) =>
  request("/api/auth/login", null, { method: "POST", body: JSON.stringify({ email, password }) });

export const getMe = (token) => request("/api/auth/me", token);

export const getDrivers = (token) => request("/api/admin/drivers", token);
export const verifyDriver = (token, id, isVerified) =>
  request(`/api/admin/drivers/${id}/verify`, token, { method: "PATCH", body: JSON.stringify({ isVerified }) });

export const getRides = (token, status) =>
  request(`/api/admin/rides${status ? `?status=${status}` : ""}`, token);
export const updateRide = (token, id, payload) =>
  request(`/api/admin/rides/${id}`, token, { method: "PATCH", body: JSON.stringify(payload) });

// GET /api/admin/rides/live — every in-progress ride with the driver's last
// known position. This existed on the backend before any frontend used it
// (its own comment even anticipated this exact page: "no Google Maps API
// key required here... rather than embedding a live map").
export const getLiveRides = (token) => request("/api/admin/rides/live", token);

export const getAnalytics = (token) => request("/api/admin/analytics", token);

// This one isn't a JSON fetch — it returns a PNG directly, and the browser
// needs to send the admin's auth token as it loads the image. Since a plain
// <img src="..."> or window.open() can't attach an Authorization header,
// we fetch the image as a blob and hand back an object URL to display it.
export const getDriverQrImage = async (token, driverId) => {
  const res = await fetch(`${API_BASE_URL}/api/admin/drivers/${driverId}/qr`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Couldn't generate this driver's QR code.");
  }
  const blob = await res.blob();
  return URL.createObjectURL(blob);
};

export const getRiders = (token) => request("/api/admin/riders", token);
export const verifyRiderId = (token, id, status, rejectionReason) =>
  request(`/api/admin/riders/${id}/verify-id`, token, {
    method: "PATCH",
    body: JSON.stringify({ status, rejectionReason }),
  });

export const getWaitlist = (token) => request("/api/admin/waitlist", token);

export const getPanics = (token) => request("/api/admin/panics", token);
export const resolvePanic = (token, rideId, notes) =>
  request(`/api/admin/panics/${rideId}/resolve`, token, { method: "PATCH", body: JSON.stringify({ notes }) });
