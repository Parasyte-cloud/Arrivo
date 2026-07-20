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

export function getFlightStatus(flightNumber, arrIata = "LOS") {
  const params = new URLSearchParams({ flightNumber, arrIata });
  return request(`/api/flights/status?${params.toString()}`);
}

export function initializePayment(email, amountNaira) {
  return request("/api/payments/initialize", {
    method: "POST",
    body: JSON.stringify({ email, amountNaira }),
  });
}

export function verifyPayment(reference) {
  return request(`/api/payments/verify/${reference}`);
}

export function createRide(token, rideData) {
  return request("/api/rides", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(rideData),
  });
}

export function getRideHistory(token) {
  return request("/api/rides/mine", {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export function getRideDetails(token, rideId) {
  return request(`/api/rides/${rideId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export function addVehicle(token, vehicleData) {
  return request("/api/owners/vehicles", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(vehicleData),
  });
}

export function getMyVehicles(token) {
  return request("/api/owners/vehicles/mine", {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export function updateVehicleAvailability(token, vehicleId, availabilityNote) {
  return request(`/api/owners/vehicles/${vehicleId}/availability`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ availabilityNote }),
  });
}

export function getOwnerDashboard(token) {
  return request("/api/owners/dashboard", {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export function rateRide(token, rideId, rating, comment) {
  return request(`/api/rides/${rideId}/rate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ rating, comment }),
  });
}

export function registerPushToken(token, pushToken) {
  return request("/api/auth/push-token", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ pushToken }),
  });
}

export function scanRideQr(token, scanToken) {
  return request("/api/rides/scan", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ scanToken }),
  });
}

export function triggerPanic(token, rideId, note) {
  return request(`/api/rides/${rideId}/panic`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ note }),
  });
}

// One-way activation, no deactivate call — matches ridearrivo.com's design.
// Triggering panic (above) activates this automatically server-side too.
export function activateListeningDevice(token, rideId) {
  return request(`/api/rides/${rideId}/listening-device`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
}

export function getWallet(token) {
  return request("/api/wallet", {
    headers: { Authorization: `Bearer ${token}` },
  });
}

// Wallet top-up reuses the same Paystack initialize/verify flow as ride
// payment (initializePayment above) — the only wallet-specific step is
// verifyWalletTopup, which actually credits the balance server-side once
// Paystack confirms the charge succeeded.
export function verifyWalletTopup(token, reference) {
  return request("/api/wallet/topup/verify", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ reference }),
  });
}

export function getMembership(token) {
  return request("/api/memberships/mine", {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export function subscribeIndividualMembership(token) {
  return request("/api/memberships/individual/subscribe", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
}

export function subscribeCorporateMembership(token) {
  return request("/api/memberships/corporate/subscribe", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
}

export function linkCorporateDelegate(token, delegateEmail) {
  return request("/api/memberships/corporate/link-delegate", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ delegateEmail }),
  });
}
