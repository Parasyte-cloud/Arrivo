// What the apps need to know that used to be hardcoded in each of them: the
// booking notice rules, the longest a ride can be booked ahead, how to reach
// support, and what the minimum app version is. One place to change, no app
// release needed. Served by GET /api/config/booking (routes/config.js).
//
// The 12 and 48 hour rules come straight from services/bookingWindow.js, the
// same constants the booking routes enforce, so the config can never say one
// thing while the API does another.
const { ON_THE_GO_ONLY_HOURS, STANDARD_MIN_HOURS } = require("./bookingWindow");
const { minVersionFor, storeUrlFor } = require("./appVersion");

const DEFAULT_SUPPORT = {
  phone: "+2348162706078",
  phoneDisplay: "+234 816 270 6078",
  email: "info@ridearrivo.com",
};

function positiveInt(text, max) {
  const n = Number(text);
  return Number.isInteger(n) && n >= 1 && n <= max ? n : null;
}

function cleanPhone(text) {
  const value = String(text || "").trim();
  return /^\+\d{8,15}$/.test(value) ? value : null;
}

function cleanEmail(text) {
  const value = String(text || "").trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : null;
}

// client is req.appClient (see services/appVersion.js).
function buildBookingConfig(env = process.env, client = null, now = Date.now()) {
  const phone = cleanPhone(env.SUPPORT_PHONE) || DEFAULT_SUPPORT.phone;
  const phoneDisplay =
    phone === DEFAULT_SUPPORT.phone ? DEFAULT_SUPPORT.phoneDisplay : String(env.SUPPORT_PHONE_DISPLAY || "").trim() || phone;
  return {
    // Standard bookings need at least this many hours of notice. Under it the
    // rider goes to On the Go.
    minHours: ON_THE_GO_ONLY_HOURS,
    standardMinHours: STANDARD_MIN_HOURS,
    // The furthest ahead a ride can be booked, in days. null means no limit has
    // been decided yet (set BOOKING_MAX_ADVANCE_DAYS when it is). This only
    // tells the apps; ride creation does not enforce it.
    maxAdvanceDays: positiveInt(env.BOOKING_MAX_ADVANCE_DAYS, 730),
    support: {
      phone,
      phoneDisplay,
      whatsapp: phone.replace("+", ""),
      email: cleanEmail(env.SUPPORT_EMAIL) || DEFAULT_SUPPORT.email,
    },
    // Only present when the caller identified itself with the version headers.
    app:
      client && client.known
        ? { minVersion: minVersionFor(client.app, env), storeUrl: storeUrlFor(client.app, client.platform, env) }
        : null,
    serverTime: new Date(now).toISOString(),
  };
}

module.exports = { buildBookingConfig, DEFAULT_SUPPORT };
