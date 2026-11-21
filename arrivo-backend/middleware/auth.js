const { pool } = require("../db/db");
const jwt = require("jsonwebtoken");
const { enforceOperationsReadOnly } = require("./operationsReadOnly");
const { readCookie } = require("./sessionCookie");
const staffAccess = require("../services/staffAccess");

async function requireAuth(req, res, next) {
  const header = req.headers.authorization; // expected: "Bearer <token>"
  // Bearer (mobile apps, existing web pages) wins; otherwise fall back to the
  // shared single sign-on cookie used across *.ridearrivo.com.
  const bearer = header && header.startsWith("Bearer ") ? header.slice(7) : null;
  const token = bearer || readCookie(req);

  if (!token) {
    return res.status(401).json({ error: "Missing or malformed Authorization header" });
  }

  let payload;
  try {
    // Pin the algorithm. For a plain string secret jsonwebtoken already
    // defaults to the HMAC family, but pinning makes the intent explicit and
    // keeps a future change (a public key, a library upgrade) from silently
    // accepting "alg: none" or an RS/HS key confusion token. signToken in
    // routes/auth.js signs with the default, which is HS256.
    payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ["HS256"] });
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }

  req.user = payload; // { id, email, role }

  // Tokens last 7 days and nothing here touched the database, so a deleted
  // account used to keep working for the rest of that week. One lookup by
  // primary key is cheap next to the work the route is about to do anyway.
  //
  // Deliberately outside the verify catch. A database being down is not the
  // same as a bad token, and answering 401 for it would send working clients
  // to the login screen and hide the real fault.
  let live;
  try {
    live = await pool.query("SELECT deleted_at, deletion_started_at, role, token_version, is_owner, staff_permissions FROM users WHERE id = $1", [payload.id]);
  } catch (err) {
    console.error("Could not check account status for user %s:", payload.id, err.message);
    return res.status(503).json({ error: "We're having trouble right now. Please try again." });
  }

  if (!live.rows[0] || live.rows[0].deleted_at) {
    return res.status(401).json({ error: "This account no longer exists." });
  }

  // The role and the session are decided by the database, not by what the
  // token said seven days ago. Otherwise a demoted admin keeps admin rights
  // until the token expires, and a password reset does not log out a thief.
  if ((payload.tv ?? 0) !== (live.rows[0].token_version ?? 0)) {
    return res.status(401).json({ error: "Your session has ended. Please sign in again." });
  }
  req.user = { ...payload, role: live.rows[0].role ?? payload.role };

  // A deletion that got as far as revoking Apple but not as far as scrubbing.
  // Nothing new should attach to an account on its way out, so everything is
  // refused except another go at the deletion itself, which finishes the job.
  if (live.rows[0].deletion_started_at) {
    const retryingDeletion = req.method === "DELETE" && req.path === "/me";
    if (!retryingDeletion) {
      return res.status(423).json({
        error: "This account is being deleted.",
        reason: "deletion_in_progress",
      });
    }
  }

  // Staff: the console area this request belongs to decides, per person
  // (services/staffAccess.js). Paths outside every area keep the old checks.
  if (staffAccess.STAFF_ROLES.includes(req.user.role)) {
    // Lowercased because Express matches routes case-insensitively: without
    // this, /API/Admin/Wallet-Transactions reaches the route but skips the check.
    // Express also routes /api/admin//wallet-transactions to the wallet route,
    // so repeated slashes are collapsed before matching too.
    const path = String(req.originalUrl || req.url || "").split("?")[0].toLowerCase().replace(/\/{2,}/g, "/");
    const verdict = staffAccess.check({ ...live.rows[0], role: req.user.role }, req.method, path);
    if (verdict) {
      if (!verdict.ok) {
        return res.status(403).json({
          // Operations keep the wording their screens already know.
          error: req.user.role === "operations"
            ? "Operations access is read-only and limited to approved operational views"
            : verdict.has === "none"
              ? "You don't have access to this part of the console. Ask the owner or an admin."
              : "You can view this but not change it. Ask the owner or an admin for manage access.",
          code: "NO_ACCESS",
          area: verdict.area,
          need: verdict.need,
        });
      }
      req.staffAccess = verdict;
      return next();
    }
  }

  return enforceOperationsReadOnly(req, res, next);
}

// Use after requireAuth, which sets req.user.role from the database row it
// already loads, so this needs no lookup of its own.
function requireRole(role) {
  return (req, res, next) => {
    // A console permission granted to this person for this area stands in for
    // the role (services/staffAccess.js, checked in requireAuth above).
    if (req.staffAccess?.ok) return next();
    if (req.user?.role !== role) {
      return res.status(403).json({ error: `This action requires the '${role}' role` });
    }
    next();
  };
}

// For routes multiple roles should be able to reach — e.g. both 'admin'
// and 'support' can view the dashboard, but only 'admin' can act on it.
// That distinction is enforced by pairing this at the router level with
// requireRole("admin") on the specific mutating routes underneath it.
function requireAnyRole(roles) {
  return (req, res, next) => {
    if (req.staffAccess?.ok) return next();
    if (!roles.includes(req.user?.role)) {
      return res.status(403).json({ error: `This action requires one of: ${roles.join(", ")}` });
    }
    next();
  };
}

module.exports = { requireAuth, requireRole, requireAnyRole };
