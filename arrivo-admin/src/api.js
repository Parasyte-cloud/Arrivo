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
  if (!res.ok) {
    // A 401 means the token is missing/expired/invalid — every page's own
    // request() call would otherwise just fail silently or repeatedly (see
    // Sidebar.jsx's poll(), which explicitly swallows errors with
    // .catch(() => {})). Broadcasting a DOM event here — instead of
    // prop-drilling a logout callback through every api.js caller — lets
    // AuthContext listen globally and force a logout/redirect to the login
    // screen from wherever the 401 happened to occur.
    if (res.status === 401) {
      window.dispatchEvent(new Event("auth:expired"));
    }
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

export const login = (email, password) =>
  request("/api/auth/login", null, { method: "POST", body: JSON.stringify({ email, password }) });

export const getMe = (token) => request("/api/auth/me", token);

// Mints a Stream Video (+ Chat) token for the signed-in admin/support
// account — same role-agnostic /api/calls/token endpoint the mobile apps
// use (see hooks/useAdminStreamClient.js). Returns { apiKey, userId,
// videoToken, chatToken }.
export const getCallToken = (token) => request("/api/calls/token", token, { method: "POST" });

// Support tickets from the rider app. status is optional and narrows the
// list to "open" or "closed"; the backend caps the list at 200, so filtering
// server-side keeps open tickets from being pushed off by closed ones.
export const getSupportTickets = (token, status) =>
  request(`/api/support/tickets${status ? `?status=${encodeURIComponent(status)}` : ""}`, token);

// Admin only. Support accounts can read the queue but not act on it.
export const setSupportTicketStatus = (token, id, status) =>
  request(`/api/support/tickets/${id}`, token, { method: "PATCH", body: JSON.stringify({ status }) });

export const getDrivers = (token) => request("/api/admin/drivers", token);
export const verifyDriver = (token, id, isVerified) =>
  request(`/api/admin/drivers/${id}/verify`, token, { method: "PATCH", body: JSON.stringify({ isVerified }) });

// Accepts { status, search, from, to } — all optional, combined server-side
// with AND (see routes/admin.js GET /rides). Kept as one options object
// rather than positional args since this now has four independent filters.
export const getRides = (token, { status, search, from, to } = {}) => {
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  if (search) params.set("search", search);
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  const qs = params.toString();
  return request(`/api/admin/rides${qs ? `?${qs}` : ""}`, token);
};
export const updateRide = (token, id, payload) =>
  request(`/api/admin/rides/${id}`, token, { method: "PATCH", body: JSON.stringify(payload) });

// GET /api/admin/rides/live — every in-progress ride with the driver's last
// known position. This existed on the backend before any frontend used it
// (its own comment even anticipated this exact page: "no Google Maps API
// key required here... rather than embedding a live map").
export const getLiveRides = (token) => request("/api/admin/rides/live", token);

// GET /api/rides/:id/fleet — same endpoint the rider app/website use to
// show their convoy; the requireAuth check there explicitly allows admin
// role through too, so staff can see fleet companion status/assignment
// here without needing a separate admin-only route.
export const getRideFleetCompanions = (token, id) => request(`/api/rides/${id}/fleet`, token);

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

export const getWalletTransactions = (token, userId) =>
  request(`/api/admin/wallet-transactions${userId ? `?userId=${userId}` : ""}`, token);

export const adjustRiderWallet = (token, riderId, amountNaira, description) =>
  request(`/api/admin/riders/${riderId}/wallet-adjust`, token, {
    method: "PATCH",
    body: JSON.stringify({ amountNaira, description }),
  });

export const getMemberships = (token) => request("/api/admin/memberships", token);

export const getFlightIssues = (token) => request("/api/admin/flight-issues", token);

export const getVehicles = (token) => request("/api/admin/vehicles", token);

export const getWaitlist = (token) => request("/api/admin/waitlist", token);

export const getPanics = (token) => request("/api/admin/panics", token);
export const resolvePanic = (token, rideId, notes) =>
  request(`/api/admin/panics/${rideId}/resolve`, token, { method: "PATCH", body: JSON.stringify({ notes }) });

// ── Arrivo Express Phase 1 ──────────────────────────────────────────────
export const getSystemConfig = (token) => request("/api/admin/config", token);
export const updateSystemConfig = (token, key, value) =>
  request(`/api/admin/config/${key}`, token, { method: "PATCH", body: JSON.stringify({ value }) });

export const getRideCancellations = (token) => request("/api/admin/ride-cancellations", token);

export const getFamilyPlans = (token) => request("/api/admin/family-plans", token);

// ── Arrivo Express Phase 2 (launch promos) ──────────────────────────────
export const getLaunchPromos = (token) => request("/api/admin/launch-promos", token);

// ── Arrivo Express Phase 3 (Arrivo Share, the Partner Venues program) ──────────
export const getArrivoShare = (token) => request("/api/admin/arrivo-share", token);

export const getPartnerVenues = (token) => request("/api/admin/partner-venues", token);
export const createPartnerVenue = (token, venue) =>
  request("/api/admin/partner-venues", token, { method: "POST", body: JSON.stringify(venue) });
export const updatePartnerVenue = (token, id, updates) =>
  request(`/api/admin/partner-venues/${id}`, token, { method: "PATCH", body: JSON.stringify(updates) });

// ── Operations CSV exports ──────────────────────────────────────────────
export const getExportList = (token) => request("/api/admin/exports", token);
export const getExportHistory = (token) => request("/api/admin/exports/history", token);

// A download cannot go through request(): that parses JSON, and this answers
// with a file. It also cannot be a plain link, because the file is behind the
// sign-in token, which a link cannot carry. So fetch it with the token, then
// hand the bytes to the browser as a download.
export async function downloadExport(token, dataset, { from, to } = {}) {
  const params = new URLSearchParams();
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  const qs = params.toString();

  const res = await fetch(`${API_BASE_URL}/api/admin/exports/${encodeURIComponent(dataset)}${qs ? `?${qs}` : ""}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    if (res.status === 401) window.dispatchEvent(new Event("auth:expired"));
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Download failed (${res.status})`);
  }

  const disposition = res.headers.get("Content-Disposition") || "";
  const match = disposition.match(/filename="([^"]+)"/);
  const filename = match ? match[1] : `arrivo-${dataset}.csv`;
  const rows = Number(res.headers.get("X-Row-Count"));

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);

  return { filename, rows: Number.isFinite(rows) ? rows : null };
}

// ── ArrivoExpress pricing, quests and automation (admin only) ───────────
const EX = "/api/admin/express";
export const getExpressPrices = (token) => request(`${EX}/prices`, token);
export const getExpressPriceHistory = (token, tier) =>
  request(`${EX}/prices/history${tier ? `?tier=${encodeURIComponent(tier)}` : ""}`, token);
export const publishExpressPrices = (token, body) =>
  request(`${EX}/prices`, token, { method: "POST", body: JSON.stringify(body) });
export const logExpressSample = (token, body) =>
  request(`${EX}/samples`, token, { method: "POST", body: JSON.stringify(body) });
export const getExpressComparison = (token, days = 7) => request(`${EX}/comparison?days=${days}`, token);
export const getExpressQuests = (token) => request(`${EX}/quests`, token);
export const createExpressQuest = (token, body) =>
  request(`${EX}/quests`, token, { method: "POST", body: JSON.stringify(body) });
export const endExpressQuest = (token, id) => request(`${EX}/quests/${id}/end`, token, { method: "POST" });
export const getExpressPayouts = (token, status) =>
  request(`${EX}/payouts${status ? `?status=${status}` : ""}`, token);
export const markExpressPayoutPaid = (token, id) => request(`${EX}/payouts/${id}/paid`, token, { method: "POST" });
export const payExpressPayoutToWallet = (token, id) => request(`${EX}/payouts/${id}/pay-wallet`, token, { method: "POST" });
export const payAllExpressPayouts = (token) =>
  request(`${EX}/payouts/pay-all-owed`, token, { method: "POST", body: JSON.stringify({ confirm: true }) });
export const getExpressAutomation = (token) => request(`${EX}/automation`, token);
export const setExpressAutomation = (token, key, enabled) =>
  request(`${EX}/automation`, token, { method: "PATCH", body: JSON.stringify({ key, enabled }) });
export const getExpressRepricePlan = (token) => request(`${EX}/reprice/plan`, token);
export const applyExpressReprice = (token) => request(`${EX}/reprice/apply`, token, { method: "POST" });
export const getAdminCashouts = (token, status) =>
  request(`/api/admin/cashouts${status ? `?status=${status}` : ""}`, token);
export const approveCashout = (token, id) => request(`/api/admin/cashouts/${id}/approve`, token, { method: "POST" });
export const declineCashout = (token, id, reason) =>
  request(`/api/admin/cashouts/${id}/decline`, token, { method: "POST", body: JSON.stringify({ reason }) });
export const checkCashout = (token, id) => request(`/api/admin/cashouts/${id}/check`, token, { method: "POST" });
export const getExpressSampleRoutes = (token) => request(`${EX}/samples/routes`, token);
export const getExpressSampleCoverage = (token) => request(`${EX}/samples/coverage`, token);
export const logExpressSamplesBulk = (token, rows) =>
  request(`${EX}/samples/bulk`, token, { method: "POST", body: JSON.stringify({ rows }) });
