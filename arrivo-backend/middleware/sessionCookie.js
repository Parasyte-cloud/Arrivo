// Shared single sign-on for every *.ridearrivo.com site.
//
// Login responses ALSO set the JWT as an HttpOnly cookie scoped to the parent
// domain, so a rider who signs in on www.ridearrivo.com is already signed in
// on express., move., air., boat. and so on. Browsers send the cookie to every
// subdomain automatically; page JavaScript can never read it (so an XSS bug on
// one site cannot steal the session, unlike a token in localStorage).
//
// Mobile apps and any existing Bearer-token client are unaffected: requireAuth
// accepts either, and Bearer wins if both are present.
//
// IMPORTANT: a browser only accepts a cookie for Domain=.ridearrivo.com when
// the response comes from a host inside ridearrivo.com. The API therefore has
// to be served from something like api.ridearrivo.com (a custom domain on
// Render). From arrivo-backend-g1ku.onrender.com the cookie is rejected or
// treated as a third-party cookie, which browsers increasingly block.
//
// Env:
//   SESSION_COOKIE_DOMAIN  e.g. ".ridearrivo.com". Unset = host-only cookie
//                          (fine for local development).
//   SESSION_COOKIE_NAME    default "arrivo_session".
//   SESSION_COOKIE_SECURE  "false" to allow plain http (local only). Default true
//                          in production.

const COOKIE_NAME = process.env.SESSION_COOKIE_NAME || "arrivo_session";
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // matches TOKEN_EXPIRY "7d" in routes/auth.js

function cookieOptions() {
  const secureEnv = process.env.SESSION_COOKIE_SECURE;
  const secure = secureEnv
    ? secureEnv.toLowerCase() !== "false"
    : process.env.NODE_ENV === "production";
  const opts = {
    httpOnly: true,
    secure,
    // Lax: sent on same-site requests (all our subdomains are same-site) and
    // on top-level navigations, NOT on cross-site POSTs. That is the main
    // CSRF defence; csrfOriginCheck below is the second layer.
    sameSite: "lax",
    path: "/",
  };
  if (process.env.SESSION_COOKIE_DOMAIN) opts.domain = process.env.SESSION_COOKIE_DOMAIN;
  return opts;
}

function setSessionCookie(res, token) {
  res.cookie(COOKIE_NAME, token, { ...cookieOptions(), maxAge: MAX_AGE_MS });
}

function clearSessionCookie(res) {
  // Must repeat domain/path or the browser treats it as a different cookie.
  res.clearCookie(COOKIE_NAME, cookieOptions());
}

// Tiny parser so we do not need another dependency for one cookie.
function readCookie(req, name = COOKIE_NAME) {
  const header = req.headers && req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    if (part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch (e) {
        return null;
      }
    }
  }
  return null;
}

// CSRF second layer. A cookie is sent automatically, which is exactly what
// makes CSRF possible, so for state-changing requests that carry the session
// cookie (and no explicit Bearer header) the browser-supplied Origin must be
// one of our own sites. Requests with a Bearer header, or with no session
// cookie at all, have nothing ambient to abuse and pass straight through.
function csrfOriginCheck(allowedOrigins) {
  const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);
  return (req, res, next) => {
    if (SAFE.has(req.method)) return next();
    if (req.headers.authorization) return next();
    if (!readCookie(req)) return next();
    const origin = req.headers.origin;
    if (origin && allowedOrigins.includes(origin)) return next();
    return res.status(403).json({ error: "Request origin not allowed." });
  };
}

module.exports = { COOKIE_NAME, setSessionCookie, clearSessionCookie, readCookie, csrfOriginCheck };
