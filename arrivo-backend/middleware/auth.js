const { pool } = require("../db/db");
const jwt = require("jsonwebtoken");
const { enforceOperationsReadOnly } = require("./operationsReadOnly");

async function requireAuth(req, res, next) {
  const header = req.headers.authorization; // expected: "Bearer <token>"
  const token = header && header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: "Missing or malformed Authorization header" });
  }

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
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
    live = await pool.query("SELECT deleted_at FROM users WHERE id = $1", [payload.id]);
  } catch (err) {
    console.error("Could not check account status for user %s:", payload.id, err.message);
    return res.status(503).json({ error: "We're having trouble right now. Please try again." });
  }

  if (!live.rows[0] || live.rows[0].deleted_at) {
    return res.status(401).json({ error: "This account no longer exists." });
  }

  return enforceOperationsReadOnly(req, res, next);
}

// Use after requireAuth. The role is embedded in the JWT itself, so this
// is a cheap check with no extra database lookup.
function requireRole(role) {
  return (req, res, next) => {
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
    if (!roles.includes(req.user?.role)) {
      return res.status(403).json({ error: `This action requires one of: ${roles.join(", ")}` });
    }
    next();
  };
}

module.exports = { requireAuth, requireRole, requireAnyRole };
