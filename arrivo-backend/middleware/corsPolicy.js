// CORS origin check and the error handling that goes with it, kept out of
// server.js so a test can drive the real code over HTTP without a database.

const REJECTED_CODE = "CORS_ORIGIN_NOT_ALLOWED";

// Requests with NO Origin header (the mobile apps, curl, server to server
// calls) always pass. CORS is enforced by browsers, so only a browser sends an
// Origin that can be refused.
function makeOriginCheck(allowedOrigins) {
  return function origin(requestOrigin, callback) {
    if (!requestOrigin || allowedOrigins.includes(requestOrigin)) {
      return callback(null, true);
    }
    // Tagged so the handler below answers 403. A plain Error thrown here used
    // to fall through to the generic 500, which looks like an outage in logs
    // and monitoring when it is only a browser from an origin we do not serve.
    const rejected = new Error("Not allowed by CORS");
    rejected.status = 403;
    rejected.code = REJECTED_CODE;
    return callback(rejected);
  };
}

// Returns true when it answered the request, so the caller's error handler can
// stop there. Expected traffic from the wrong origin is not logged as a fault.
function respondIfCorsRejection(err, res) {
  if (!err || err.code !== REJECTED_CODE) return false;
  res.status(403).json({ error: "This origin is not allowed." });
  return true;
}

module.exports = { makeOriginCheck, respondIfCorsRejection, REJECTED_CODE };
