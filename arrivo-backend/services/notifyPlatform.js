// Sends customer lifecycle events to the Arrivo Notification Platform (Supabase function arrivo-notify-ingest).
//
// Safe by design:
//  - Never throws and never blocks a request. If the platform is down, signup still works.
//  - Signed with HMAC-SHA256 over "<unix seconds>.<body>" using NOTIFY_INGEST_SECRET (32+ characters).
//  - Every event has a stable key, so a retry or a replay can never create a second welcome journey.
//  - Does nothing unless NOTIFY_INGEST_URL and NOTIFY_INGEST_SECRET are both set.
//
// Cutover: while NOTIFY_PLATFORM_CUSTOMER_EMAIL / NOTIFY_PLATFORM_BOOKING_EMAIL are not "true" the old
// welcome / booking emails keep sending. Set each to "true" at the same time customer email is turned ON
// in the Notification Center, so a customer never gets both.

const crypto = require("crypto");

const ATTEMPTS = 3;
const TIMEOUT_MS = 5000;

function config() {
  const url = (process.env.NOTIFY_INGEST_URL || "").trim();
  const secret = process.env.NOTIFY_INGEST_SECRET || "";
  return { url, secret, ready: /^https:\/\//.test(url) && secret.length >= 32 };
}

// True once the platform owns the welcome email and journey.
function platformOwnsCustomerEmail() {
  return String(process.env.NOTIFY_PLATFORM_CUSTOMER_EMAIL || "").toLowerCase() === "true";
}

// True once the platform owns booking confirmation emails. Separate flag on purpose: switch it only after
// the platform has been seen emailing bookings made through this backend (see the runbook).
function platformOwnsBookingEmail() {
  return String(process.env.NOTIFY_PLATFORM_BOOKING_EMAIL || "").toLowerCase() === "true";
}

function sign(secret, timestamp, body) {
  return crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(cfg, body) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(cfg.url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-arrivo-timestamp": timestamp, "x-arrivo-signature": sign(cfg.secret, timestamp, body) },
      body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

// Returns { sent: boolean, reason?: string }. Never rejects.
async function emitCustomerEvent(type, { key, customerRef, email, name, payload }) {
  const cfg = config();
  if (!cfg.ready) return { sent: false, reason: "not_configured" };
  if (!email || !customerRef || !key) return { sent: false, reason: "missing_fields" };
  const body = JSON.stringify({ kind: "customer", event_type: type, event_key: key, customer_ref: String(customerRef), email: String(email).toLowerCase(), name: name || null, payload: payload || {} });
  let last = "unknown";
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const res = await post(cfg, body);
      if (res.status >= 200 && res.status < 300) return { sent: true };
      last = `http_${res.status}`;
      if (res.status >= 400 && res.status < 500 && res.status !== 429) break; // our request is wrong; retrying will not help
    } catch (e) {
      last = e && e.name === "AbortError" ? "timeout" : "network";
    }
    if (attempt < ATTEMPTS) await sleep(500 * 4 ** (attempt - 1));
  }
  // Only ids in the log, never the address. scripts/replay-signup-events.js re-sends anything missed.
  console.error(`notify platform: ${type} for customer ${customerRef} not delivered (${last})`);
  return { sent: false, reason: last };
}

function emitSignup(user, { emailVerified, marketingConsent } = {}) {
  return emitCustomerEvent("user.signup.completed", {
    key: `user.signup.completed:${user.id}`,
    customerRef: user.id,
    email: user.email,
    name: user.name,
    payload: {
      email_verified: emailVerified === undefined ? !!user.email_verified : !!emailVerified,
      marketing_consent: !!marketingConsent,
      signup_at: (user.created_at ? new Date(user.created_at) : new Date()).toISOString(),
      preferred_language: user.preferred_language || null,
      country: user.country_of_residence || null,
    },
  });
}

function emitEmailVerified(user) {
  return emitCustomerEvent("user.email.verified", { key: `user.email.verified:${user.id}`, customerRef: user.id, email: user.email, name: user.name, payload: {} });
}

function emitAccountDeactivated(user) {
  return emitCustomerEvent("account.deactivated", { key: `account.deactivated:${user.id}`, customerRef: user.id, email: user.email, name: user.name, payload: {} });
}

module.exports = { config, platformOwnsCustomerEmail, platformOwnsBookingEmail, sign, emitCustomerEvent, emitSignup, emitEmailVerified, emitAccountDeactivated };
