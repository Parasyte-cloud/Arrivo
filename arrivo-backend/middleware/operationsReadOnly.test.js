const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const { requireAuth } = require("./auth");

const previousSecret = process.env.JWT_SECRET;
process.env.JWT_SECRET = "operations-rbac-local-test-secret";

function requestFor(role, method, originalUrl) {
  const token = jwt.sign(
    {
      id: 999,
      email: `${role}@example.test`,
      role,
    },
    process.env.JWT_SECRET,
    { expiresIn: "5m" }
  );

  let nextCalled = false;
  let statusCode = 200;
  let responseBody = null;

  const req = {
    method,
    originalUrl,
    url: originalUrl,
    headers: {
      authorization: `Bearer ${token}`,
    },
  };

  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      responseBody = body;
      return this;
    },
  };

  requireAuth(req, res, () => {
    nextCalled = true;
  });

  return {
    nextCalled,
    statusCode,
    responseBody,
  };
}

const allowedOperationsGets = [
  "/api/auth/me",
  "/api/admin/drivers",
  "/api/admin/rides",
  "/api/admin/rides?status=in_progress",
  "/api/admin/rides/live",
  "/api/admin/panics",
  "/api/admin/flight-issues",
  "/api/admin/vehicles",
  "/api/admin/analytics",
  "/api/live-map/snapshot",
  "/api/alerts",
  "/api/alerts/alert-123",
  "/api/on-the-go",
  "/api/rides/ride-123/fleet",
];

test("operations may access approved read-only GET views", () => {
  for (const url of allowedOperationsGets) {
    const result = requestFor("operations", "GET", url);

    assert.equal(
      result.nextCalled,
      true,
      `expected GET ${url} to pass`
    );
    assert.equal(result.statusCode, 200);
  }
});

const blockedOperationsRequests = [
  ["GET", "/api/admin/riders"],
  ["GET", "/api/admin/wallet-transactions"],
  ["GET", "/api/admin/memberships"],
  ["GET", "/api/admin/waitlist"],
  ["GET", "/api/rides/ride-123"],
  ["GET", "/api/rides/ride-123/share"],
  ["GET", "/api/support/tickets"],
  ["GET", "/api/events"],
  ["GET", "/api/wallet"],
  ["GET", "/api/memberships/mine"],
  ["POST", "/api/calls/token"],
  ["POST", "/api/on-the-go"],
  ["POST", "/api/rides"],
  ["POST", "/api/rides/quote"],
  ["PATCH", "/api/auth/me"],
  ["PATCH", "/api/admin/rides/123"],
  ["PATCH", "/api/admin/drivers/123/verify"],
  ["PATCH", "/api/admin/panics/123/resolve"],
];

test("operations is deny-by-default outside approved GET views", () => {
  for (const [method, url] of blockedOperationsRequests) {
    const result = requestFor("operations", method, url);

    assert.equal(
      result.nextCalled,
      false,
      `expected ${method} ${url} to be blocked`
    );
    assert.equal(result.statusCode, 403);
    assert.match(
      result.responseBody?.error || "",
      /Operations access is read-only/
    );
  }
});

test("admin behavior is unchanged by the operations gate", () => {
  const result = requestFor(
    "admin",
    "POST",
    "/api/calls/token"
  );

  assert.equal(result.nextCalled, true);
  assert.equal(result.statusCode, 200);
});

test("support behavior is unchanged by the operations gate", () => {
  const result = requestFor(
    "support",
    "GET",
    "/api/admin/wallet-transactions"
  );

  assert.equal(result.nextCalled, true);
  assert.equal(result.statusCode, 200);
});

test.after(() => {
  if (previousSecret === undefined) {
    delete process.env.JWT_SECRET;
  } else {
    process.env.JWT_SECRET = previousSecret;
  }
});
