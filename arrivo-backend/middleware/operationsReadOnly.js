const OPERATIONS_GET_RULES = [
  /^\/api\/auth\/me\/?$/,
  /^\/api\/admin\/drivers\/?$/,
  /^\/api\/admin\/rides\/?$/,
  /^\/api\/admin\/rides\/live\/?$/,
  /^\/api\/admin\/panics\/?$/,
  /^\/api\/admin\/flight-issues\/?$/,
  /^\/api\/admin\/vehicles\/?$/,
  /^\/api\/admin\/analytics\/?$/,
  /^\/api\/live-map\/snapshot\/?$/,
  /^\/api\/alerts\/?$/,
  /^\/api\/alerts\/[^/]+\/?$/,
  /^\/api\/rides\/[^/]+\/fleet\/?$/,
  /^\/api\/on-the-go\/?$/,
];

function requestPath(req) {
  return String(req.originalUrl || req.url || "").split("?")[0];
}

function enforceOperationsReadOnly(req, res, next) {
  if (req.user?.role !== "operations") {
    return next();
  }

  const path = requestPath(req);

  if (
    req.method === "GET"
    && OPERATIONS_GET_RULES.some((rule) => rule.test(path))
  ) {
    return next();
  }

  return res.status(403).json({
    error:
      "Operations access is read-only and limited to approved operational views",
  });
}

module.exports = {
  OPERATIONS_GET_RULES,
  enforceOperationsReadOnly,
};
