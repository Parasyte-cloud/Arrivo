// Origin lock: only accept requests that came through Cloudflare.
//
// Why: Cloudflare's firewall, rate limits and bot rules only protect traffic
// that goes through Cloudflare. While the Render hostname
// (arrivo-backend-g1ku.onrender.com) answers directly, anyone can skip all of
// it. The fix is a shared secret: a Cloudflare Transform Rule adds the header
// below on every request to api.ridearrivo.com, and this middleware refuses
// anything without it.
//
// IMPORTANT, read before turning it on: the rider and driver mobile apps are
// currently built with the Render hostname as their API URL (see app.json in
// arrivo-app and arrivo-driver-app). Those requests do NOT pass through
// Cloudflare, so enforcing the lock would break every installed app. That is
// why there are three modes:
//
//   off      (default) does nothing.
//   report   lets everything through, but logs "would block" lines so you can
//            see exactly who still uses the direct URL.
//   enforce  returns 403 to anything without the secret header.
//
// Move to enforce only after the apps ship with api.ridearrivo.com and the
// report log has gone quiet.
//
// Fail open on purpose: if a mode other than "off" is set but the secret is
// empty, the lock disables itself and logs loudly. Failing closed would turn a
// typo in an environment variable into a full outage.
//
// Environment:
//   ORIGIN_LOCK_MODE      off | report | enforce
//   ORIGIN_LOCK_SECRET    long random string, same value as the Cloudflare rule
//   ORIGIN_LOCK_EXEMPT    comma separated paths that skip the check, for
//                         example /api/payments/webhook if Paystack calls the
//                         Render URL directly. A path matches itself and
//                         anything below it.
const crypto = require("crypto");

const HEADER = "x-origin-secret";
const MODES = ["off", "report", "enforce"];

// Hash both sides first so the comparison is constant time and the lengths
// never differ, whatever the caller sends.
function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function parseList(value) {
  return String(value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function originLock(options = {}) {
  const log = options.log || console.warn;
  const secret = options.secret !== undefined ? options.secret : process.env.ORIGIN_LOCK_SECRET || "";
  let mode = String(options.mode !== undefined ? options.mode : process.env.ORIGIN_LOCK_MODE || "off").toLowerCase();
  const exempt = options.exempt || parseList(process.env.ORIGIN_LOCK_EXEMPT);

  if (!MODES.includes(mode)) {
    log(`origin-lock: unknown ORIGIN_LOCK_MODE "${mode}", lock is off`);
    mode = "off";
  }
  if (mode !== "off" && !secret) {
    log(`origin-lock: ORIGIN_LOCK_MODE is "${mode}" but ORIGIN_LOCK_SECRET is empty, lock is off`);
    mode = "off";
  }
  if (mode === "off") return (req, res, next) => next();

  // In report mode a busy day could write thousands of lines, so cap the
  // logging at 20 lines a minute and say how many were skipped.
  let windowStart = Date.now();
  let logged = 0;
  let skipped = 0;
  function report(req) {
    const now = Date.now();
    if (now - windowStart >= 60000) {
      if (skipped) log(`origin-lock: ${skipped} more would-block lines skipped in the last minute`);
      windowStart = now;
      logged = 0;
      skipped = 0;
    }
    if (logged < 20) {
      logged++;
      // Path only, never the query string or the presented header.
      log(`origin-lock: would block ${req.method} ${req.path}`);
    } else {
      skipped++;
    }
  }

  return function originLockMiddleware(req, res, next) {
    const exempted = exempt.some((p) => {
      const base = p.endsWith("/") ? p.slice(0, -1) : p;
      return req.path === base || req.path.startsWith(base + "/");
    });
    if (exempted) return next();

    const presented = req.get(HEADER);
    if (presented && safeEqual(presented, secret)) return next();

    if (mode === "report") {
      report(req);
      return next();
    }
    return res.status(403).json({ error: "Forbidden" });
  };
}

module.exports = { originLock, HEADER };
