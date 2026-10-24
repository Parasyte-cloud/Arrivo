const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");

// requireAuth now checks the account still exists on every request. This
// suite is about the operations gate, so the lookup always finds a live one.
// staffPermissions lets a test give the account per-area console permissions
// (services/staffAccess.js).
let staffPermissions = null;
const dbPath = require.resolve("../db/db");
require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: {
    pool: {
      async query() {
        return { rows: [{ deleted_at: null, deletion_started_at: null, staff_permissions: staffPermissions }] };
      },
    },
  },
};

const { requireAuth } = require("./auth");

const previousSecret = process.env.JWT_SECRET;
process.env.JWT_SECRET = "operations-rbac-local-test-secret";

async function requestFor(role, method, originalUrl) {
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

  await requireAuth(req, res, () => {
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
  "/api/admin/exports",
  "/api/admin/exports/riders?from=2026-10-01&to=2026-10-31",
  "/api/admin/exports/arrivoexpress-requests",
  "/api/live-map/snapshot",
  "/api/alerts",
  "/api/alerts/alert-123",
  "/api/on-the-go",
  "/api/rides/ride-123/fleet",
];

test("operations may access approved read-only GET views", async () => {
  for (const url of allowedOperationsGets) {
    const result = await requestFor("operations", "GET", url);

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
  ["POST", "/api/on-the-go"],
  ["POST", "/api/staff/rides/12/reassign"],
  ["PUT", "/api/staff/lead/5"],
  ["GET", "/api/staff/access-log"],
  ["PUT", "/api/staff/duty/extra"],
  ["POST", "/api/calls/ride/12/start"],
  ["POST", "/api/calls/abc/support"],
  ["POST", "/api/staff/rides/x/contact-log"],
  ["POST", "/api/rides"],
  ["POST", "/api/rides/quote"],
  ["PATCH", "/api/auth/me"],
  ["PATCH", "/api/admin/rides/123"],
  ["PATCH", "/api/admin/drivers/123/verify"],
  ["PATCH", "/api/admin/panics/123/resolve"],
  ["POST", "/api/admin/exports/riders"],
  ["DELETE", "/api/admin/exports/riders"],
  ["GET", "/api/admin/exports/riders/extra/path"],
];

test("operations is deny-by-default outside approved GET views", async () => {
  for (const [method, url] of blockedOperationsRequests) {
    const result = await requestFor("operations", method, url);

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

test("operations may do the few things the Rides section needs", async () => {
  for (const [method, url] of [
    ["GET", "/api/staff/rides"],
    ["GET", "/api/staff/rides/42"],
    ["GET", "/api/staff/duty"],
    ["GET", "/api/staff/team"],
    ["PUT", "/api/staff/duty"],
    ["POST", "/api/staff/rides/42/contact-log"],
    ["POST", "/api/calls/staff/ride/42/start"],
    ["POST", "/api/calls/token"],
    ["POST", "/api/calls/some-session-id/events"],
  ]) {
    const result = await requestFor("operations", method, url);
    assert.equal(result.nextCalled, true, `expected ${method} ${url} to be allowed`);
  }
});

test("admin behavior is unchanged by the operations gate", async () => {
  const result = await requestFor(
    "admin",
    "POST",
    "/api/calls/token"
  );

  assert.equal(result.nextCalled, true);
  assert.equal(result.statusCode, 200);
});

// Support used to see every page. They now start with what the job needs and
// the owner grants the rest per person (services/staffAccess.js).
test("operations can read their own console permissions", async () => {
  for (const url of ["/api/staff/access/me", "/api/staff/access/catalog"]) {
    const result = await requestFor("operations", "GET", url);
    assert.equal(result.nextCalled, true, `expected GET ${url} to pass`);
  }
});

test("support doesn't see the wallet unless it's granted", async () => {
  const result = await requestFor("support", "GET", "/api/admin/wallet-transactions");
  assert.equal(result.nextCalled, false);
  assert.equal(result.statusCode, 403);
  assert.equal(result.responseBody?.code, "NO_ACCESS");
});

test("an upper-case path doesn't skip the console permission check", async () => {
  const result = await requestFor("support", "GET", "/API/Admin/Wallet-Transactions");
  assert.equal(result.nextCalled, false);
  assert.equal(result.statusCode, 403);
  assert.equal(result.responseBody?.code, "NO_ACCESS");
});

test("support sees the wallet once it's granted", async () => {
  staffPermissions = { wallet: "view" };
  try {
    const result = await requestFor("support", "GET", "/api/admin/wallet-transactions");
    assert.equal(result.nextCalled, true);
    assert.equal(result.statusCode, 200);
  } finally {
    staffPermissions = null;
  }
});

test.after(() => {
  if (previousSecret === undefined) {
    delete process.env.JWT_SECRET;
  } else {
    process.env.JWT_SECRET = previousSecret;
  }
});
