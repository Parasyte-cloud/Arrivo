const jwt = require("jsonwebtoken");

function requireAuth(req, res, next) {
  const header = req.headers.authorization; // expected: "Bearer <token>"
  const token = header && header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: "Missing or malformed Authorization header" });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload; // { id, email, role }
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
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
