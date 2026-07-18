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

export function triggerPanic(token, rideId, note) {
  return request(`/api/rides/${rideId}/panic`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ note }),
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
