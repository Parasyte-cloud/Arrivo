import { API_BASE_URL } from "./config";

async function request(path, options = {}) {
  // NOTE: headers must be merged, not spread at the top level — any caller
  // that passes its own `headers` (e.g. { Authorization }, which is nearly
  // every authenticated call in this file) would otherwise silently replace
  // this whole object and drop Content-Type entirely, since object spread
  // only merges top-level keys. Without Content-Type: application/json,
  // Express's body parser never parses the JSON body at all.
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

// `fetch` itself rejects (before any response exists) when there's no
// connectivity at all — React Native's fetch polyfill throws a TypeError
// with a message like "Network request failed" in that case. That's a
// fundamentally different situation from `request()`'s normal thrown Error
// above (which means the server WAS reached and gave a definitive answer,
// e.g. "wrong driver" or "already started"). Callers that need to offer an
// offline fallback (see ScanScreen.js) use this to tell the two apart —
// only a genuine connectivity failure should trigger offline behavior;
// a real server rejection should just be shown to the user as-is.
export function isNetworkError(e) {
  const msg = String(e && e.message ? e.message : "");
  return /network request failed|failed to fetch|network error|timed out|timeout|abort/i.test(msg);
}

export function getFlightStatus(token, flightNumber, arrIata = "LOS") {
  const params = new URLSearchParams({ flightNumber, arrIata });
  return request(`/api/flights/status?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

// Always responds the same generic message whether or not the email has an
// account (see the backend route) — this call succeeding just means the
// request went through, not that an email necessarily exists for it.
export function forgotPassword(email) {
  return request("/api/auth/forgot-password", { method: "POST", body: JSON.stringify({ email }) });
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

// Proxied through our own backend rather than calling Google directly —
// keeps the Places API key server-side only. sessionToken should be a
// fresh random string generated once per address-entry session (see
// components/AddressAutocomplete.js) so Google bills the autocomplete
// keystrokes + the eventual details lookup together as one session.
export function getPlacesAutocomplete(token, input, sessionToken) {
  const params = new URLSearchParams({ input, sessionToken });
  return request(`/api/places/autocomplete?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export function getPlaceDetails(token, placeId, sessionToken) {
  const params = new URLSearchParams({ placeId, sessionToken });
  return request(`/api/places/details?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

// Live fare estimate before payment — same formula the backend
// re-verifies against when the ride is actually created, so this number
// is what the rider will actually be charged (barring live traffic
// shifting slightly in the few minutes before they pay).
export function getFareQuote(token, quoteData) {
  return request("/api/rides/quote", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(quoteData),
  });
}

// Current naira-per-dollar rate, for showing a $ estimate to riders booking
// from outside Nigeria (see useCurrency hook + arrivo-backend/services/fx.js
// — naira is always the real, charged amount; this is display-only).
export function getFxRate(token) {
  return request("/api/rides/fx-rate", {
    headers: { Authorization: `Bearer ${token}` },
  });
}

// Whether this rider currently holds the required minimum wallet balance
// (~$100-equivalent) that must be met before any ride can be booked,
// regardless of which payment method they use for the fare itself.
export function getWalletMinimum(token) {
  return request("/api/rides/wallet-minimum", {
    headers: { Authorization: `Bearer ${token}` },
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

// keepSameDriver: "keep the same driver and vehicle for my return trip" —
// stored on this (arrival) ride and copied onto a later linked drop-off
// booking automatically. See db/schema.sql's keep_same_driver_for_return.
export function rateRide(token, rideId, rating, comment, keepSameDriver) {
  return request(`/api/rides/${rideId}/rate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ rating, comment, keepSameDriver }),
  });
}

// Optional post-trip tip — wallet debits immediately server-side; a card
// tip requires paymentReference from a Paystack charge that's already been
// verified client-side first (see verifyPayment), same two-step pattern
// CheckoutScreen uses for the fare itself. Never cash.
export function tipRide(token, rideId, amountNaira, paymentMethod, paymentReference) {
  return request(`/api/rides/${rideId}/tip`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ amountNaira, paymentMethod, paymentReference }),
  });
}

// Pays off an automatically-computed Chauffeur time-overage charge (see
// ride.overage_naira, set server-side at trip completion — TrackingScreen's
// "Extra time charge" card). Unlike tipRide, there's no amountNaira here —
// the amount is whatever the backend already computed, not rider-chosen.
export function payRideOverage(token, rideId, paymentMethod, paymentReference) {
  return request(`/api/rides/${rideId}/overage-charge`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ paymentMethod, paymentReference }),
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
