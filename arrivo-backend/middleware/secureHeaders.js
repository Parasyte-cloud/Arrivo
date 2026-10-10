// Baseline response headers for a JSON API.
//
// The API never serves pages that should be framed, sniffed or cached, so these
// are safe defaults. They are set before routing, so any route can still
// override one (for example the SSE route sets its own Cache-Control).
//
// Deliberately not included: Content-Security-Policy. Some routes return small
// HTML pages (email verification, for example), and a strict API-wide policy
// would break their inline styles. The website and admin app send their own.
//
// HSTS is only sent when the request really arrived over https. With
// `trust proxy` set in server.js, req.secure follows X-Forwarded-Proto, so a
// plain-http local run never tells your browser to refuse http for localhost.
function secureHeaders() {
  return function secureHeadersMiddleware(req, res, next) {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Permissions-Policy", "geolocation=(), camera=(), microphone=()");
    if (req.secure) {
      res.setHeader("Strict-Transport-Security", "max-age=31536000");
    }
    if (req.path.startsWith("/api/")) {
      res.setHeader("Cache-Control", "no-store");
    }
    next();
  };
}

module.exports = { secureHeaders };
