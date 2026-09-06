// Tests for the support intake endpoints. Runs the real Express router and
// the real auth middleware against an in-memory stand-in for the pg pool, so
// there's no database to set up. Run directly:
//   node routes/support.test.js

const assert = require("assert");
const http = require("http");
const express = require("express");
require("express-async-errors");
const jwt = require("jsonwebtoken");

process.env.JWT_SECRET = "test-secret-for-support-route-tests";

let passed = 0;
function test(name, fn) {
  return (async () => {
    try {
      await fn();
      console.log(`  ok  ${name}`);
      passed++;
    } catch (e) {
      console.log(`FAIL  ${name}`);
      console.log(`      ${e.message}`);
      process.exitCode = 1;
    }
  })();
}

// Rides belong to whoever's listed here. Only the queries the route actually
// issues are implemented. This is a stand-in, not a SQL engine.
// Ride 1 is owned by rider 1 on purpose: a coerced `true` becomes 1, and
// without that row the ownership check would mask the coercion bug.
const RIDES = [
  { id: 7, rider_id: 1 },
  { id: 8, rider_id: 2 },
  { id: 1, rider_id: 1 },
];

const inserted = [];
const fakePool = {
  async query(sql, params = []) {
    const s = sql.replace(/\s+/g, " ").trim();

    // requireAuth now confirms the account has not been deleted, on every
    // request, so the stand-in has to answer that too.
    if (s.startsWith("SELECT deleted_at FROM users")) {
      return { rows: [{ deleted_at: null }] };
    }

    if (s.startsWith("SELECT id FROM rides")) {
      const [id, riderId] = params;
      // Mirror Postgres: an out-of-range value never reaches a real INTEGER
      // column without throwing, so the fake refuses it too. Without this the
      // test would pass against the fake and still 500 in production.
      if (!Number.isInteger(id) || id > 2147483647 || id < -2147483648) {
        throw new Error(`value "${id}" is out of range for type integer`);
      }
      const ride = RIDES.find((r) => r.id === id && r.rider_id === riderId);
      return { rows: ride ? [{ id: ride.id }] : [] };
    }

    if (s.startsWith("INSERT INTO support_tickets")) {
      const [user_id, ride_id, type, subject, description] = params;
      const row = {
        id: inserted.length + 1,
        user_id,
        ride_id,
        type,
        subject,
        description,
        status: "open",
        created_at: new Date("2026-01-01T00:00:00Z").toISOString(),
      };
      inserted.push(row);
      return { rows: [row] };
    }

    if (s.startsWith("UPDATE support_tickets")) {
      const [status, id] = params;
      if (!Number.isInteger(id) || id > 2147483647 || id < -2147483648) {
        throw new Error(`value "${id}" is out of range for type integer`);
      }
      const row = inserted.find((t) => t.id === id);
      if (!row) return { rows: [] };
      row.status = status;
      return { rows: [row] };
    }

    if (s.startsWith("SELECT support_tickets.*")) {
      const wanted = params[0];
      return {
        rows: inserted
          .filter((t) => wanted == null || t.status === wanted)
          .map((t) => ({
            ...t,
            user_name: "Test Rider",
            user_email: "r@example.com",
            user_phone: null,
          })),
      };
    }

    throw new Error(`fake pool got an unexpected query: ${s}`);
  },
};

// The route pulls the pool off ../db/db, which throws on require without a
// DATABASE_URL. Seed the module cache with the fake before requiring it.
const dbPath = require.resolve("../db/db");
require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: { pool: fakePool, ready: Promise.resolve() },
};

const supportRouter = require("./support");

const app = express();
app.use(express.json());
app.use("/api/support", supportRouter);
// Same shape as server.js, so a rejected query answers 500 rather than
// hanging the request.
app.use((err, req, res, next) => res.status(500).json({ error: "Something went wrong on our end." }));

const server = http.createServer(app);

function tokenFor(id, role = "rider") {
  return jwt.sign({ id, email: `u${id}@example.com`, role }, process.env.JWT_SECRET);
}

// Every other test here posts far more than the limit allows, so the helper
// clears the caller's key first. The rate limit gets its own tests below,
// which deliberately bypass this.
function clearLimit(userId) {
  supportRouter.submitLimiter.resetKey(String(userId));
}

async function call(path, { method = "GET", token, body } = {}) {
  const { port } = server.address();
  if (method === "POST") { clearLimit(1); clearLimit(2); }
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const RIDER = tokenFor(1);
const OTHER_RIDER = tokenFor(2);
const ok = {
  type: "complaint",
  subject: "Driver took a long route",
  description: "Went via Third Mainland for no reason.",
};

(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));

  console.log("Creating a ticket:");

  await test("valid ticket is created", async () => {
    const r = await call("/api/support/tickets", { method: "POST", token: RIDER, body: ok });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.body.ticket.type, "complaint");
    assert.strictEqual(r.body.ticket.status, "open");
  });

  await test("a booking the rider owns gets attached", async () => {
    const r = await call("/api/support/tickets", { method: "POST", token: RIDER, body: { ...ok, rideId: 7 } });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.body.ticket.ride_id, 7);
  });

  await test("no rideId is fine, for a rider who has never booked", async () => {
    const r = await call("/api/support/tickets", { method: "POST", token: RIDER, body: ok });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.body.ticket.ride_id, null);
  });

  await test("subject and description are trimmed", async () => {
    const r = await call("/api/support/tickets", {
      method: "POST",
      token: RIDER,
      body: { type: "inquiry", subject: "  padded subject  ", description: "  padded body  " },
    });
    assert.strictEqual(r.body.ticket.subject, "padded subject");
    assert.strictEqual(r.body.ticket.description, "padded body");
  });

  console.log("\nYou can only attach your own booking:");

  await test("another rider's booking is refused", async () => {
    const r = await call("/api/support/tickets", { method: "POST", token: RIDER, body: { ...ok, rideId: 8 } });
    assert.strictEqual(r.status, 400);
  });

  await test("a booking that does not exist is refused", async () => {
    const r = await call("/api/support/tickets", { method: "POST", token: RIDER, body: { ...ok, rideId: 99999 } });
    assert.strictEqual(r.status, 400);
  });

  console.log("\nrideId has to be a real id:");

  await test("a rideId past INTEGER range answers 400, not 500", async () => {
    const r = await call("/api/support/tickets", { method: "POST", token: RIDER, body: { ...ok, rideId: 1e12 } });
    assert.strictEqual(r.status, 400, `got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  await test("true is not coerced into ride 1", async () => {
    // Rider 1 does own ride 1, so a plain Number(true) would attach it and
    // answer 201. The failure this guards against is silent.
    const r = await call("/api/support/tickets", { method: "POST", token: RIDER, body: { ...ok, rideId: true } });
    assert.strictEqual(r.status, 400, `got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  await test("a single-element array is not coerced into that id", async () => {
    const r = await call("/api/support/tickets", { method: "POST", token: RIDER, body: { ...ok, rideId: [7] } });
    assert.strictEqual(r.status, 400, `got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  await test("a non-numeric string is refused", async () => {
    const r = await call("/api/support/tickets", { method: "POST", token: RIDER, body: { ...ok, rideId: "not-a-number" } });
    assert.strictEqual(r.status, 400);
  });

  await test("zero and negatives are refused", async () => {
    for (const rideId of [0, -7]) {
      const r = await call("/api/support/tickets", { method: "POST", token: RIDER, body: { ...ok, rideId } });
      assert.strictEqual(r.status, 400, `rideId ${rideId} gave ${r.status}`);
    }
  });

  await test("a fractional id is refused", async () => {
    const r = await call("/api/support/tickets", { method: "POST", token: RIDER, body: { ...ok, rideId: 7.5 } });
    assert.strictEqual(r.status, 400);
  });

  await test("null and empty string mean nothing to attach, not an error", async () => {
    for (const rideId of [null, ""]) {
      const r = await call("/api/support/tickets", { method: "POST", token: RIDER, body: { ...ok, rideId } });
      assert.strictEqual(r.status, 201, `rideId ${JSON.stringify(rideId)} gave ${r.status}`);
      assert.strictEqual(r.body.ticket.ride_id, null);
    }
  });

  await test("a numeric string still works, since JSON bodies vary", async () => {
    const r = await call("/api/support/tickets", { method: "POST", token: RIDER, body: { ...ok, rideId: "7" } });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.body.ticket.ride_id, 7);
  });

  console.log("\nValidation:");

  await test("type has to be one the backend knows", async () => {
    const r = await call("/api/support/tickets", { method: "POST", token: RIDER, body: { ...ok, type: "refund" } });
    assert.strictEqual(r.status, 400);
  });

  await test("every type the app offers is accepted", async () => {
    for (const type of ["complaint", "inquiry", "support"]) {
      const r = await call("/api/support/tickets", { method: "POST", token: RIDER, body: { ...ok, type } });
      assert.strictEqual(r.status, 201, `type ${type} gave ${r.status}`);
    }
  });

  await test("a blank subject is refused", async () => {
    const r = await call("/api/support/tickets", { method: "POST", token: RIDER, body: { ...ok, subject: "   " } });
    assert.strictEqual(r.status, 400);
  });

  await test("a blank description is refused", async () => {
    const r = await call("/api/support/tickets", { method: "POST", token: RIDER, body: { ...ok, description: "" } });
    assert.strictEqual(r.status, 400);
  });

  await test("an over-long subject is refused at 141", async () => {
    const at = await call("/api/support/tickets", { method: "POST", token: RIDER, body: { ...ok, subject: "a".repeat(140) } });
    assert.strictEqual(at.status, 201);
    const over = await call("/api/support/tickets", { method: "POST", token: RIDER, body: { ...ok, subject: "a".repeat(141) } });
    assert.strictEqual(over.status, 400);
  });

  await test("an over-long description is refused at 4001", async () => {
    const at = await call("/api/support/tickets", { method: "POST", token: RIDER, body: { ...ok, description: "a".repeat(4000) } });
    assert.strictEqual(at.status, 201);
    const over = await call("/api/support/tickets", { method: "POST", token: RIDER, body: { ...ok, description: "a".repeat(4001) } });
    assert.strictEqual(over.status, 400);
  });

  await test("a missing body is refused rather than throwing", async () => {
    const r = await call("/api/support/tickets", { method: "POST", token: RIDER });
    assert.strictEqual(r.status, 400);
  });

  console.log("\nWho can do what:");

  await test("posting without a token is refused", async () => {
    const r = await call("/api/support/tickets", { method: "POST", body: ok });
    assert.strictEqual(r.status, 401);
  });

  await test("a rider cannot read the ticket queue", async () => {
    const r = await call("/api/support/tickets", { token: RIDER });
    assert.strictEqual(r.status, 403);
  });

  await test("reading the queue without a token is refused", async () => {
    const r = await call("/api/support/tickets");
    assert.strictEqual(r.status, 401);
  });

  await test("admin can read the queue", async () => {
    const r = await call("/api/support/tickets", { token: tokenFor(50, "admin") });
    assert.strictEqual(r.status, 200);
    assert.ok(Array.isArray(r.body.tickets));
  });

  await test("support can read the queue too", async () => {
    const r = await call("/api/support/tickets", { token: tokenFor(51, "support") });
    assert.strictEqual(r.status, 200);
  });

  await test("a driver cannot read the queue", async () => {
    const r = await call("/api/support/tickets", { token: tokenFor(52, "driver") });
    assert.strictEqual(r.status, 403);
  });

  await test("a ticket is filed against the caller, not a claimed user id", async () => {
    const r = await call("/api/support/tickets", {
      method: "POST",
      token: OTHER_RIDER,
      body: { ...ok, userId: 1, user_id: 1 },
    });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.body.ticket.user_id, 2);
  });

  console.log("");
  console.log("Closing a ticket is admin only:");

  await test("admin can close a ticket", async () => {
    const made = await call("/api/support/tickets", { method: "POST", token: RIDER, body: ok });
    const id = made.body.ticket.id;
    const r = await call(`/api/support/tickets/${id}`, {
      method: "PATCH", token: tokenFor(50, "admin"), body: { status: "closed" },
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ticket.status, "closed");
  });

  await test("support is read only and cannot close", async () => {
    const made = await call("/api/support/tickets", { method: "POST", token: RIDER, body: ok });
    const r = await call(`/api/support/tickets/${made.body.ticket.id}`, {
      method: "PATCH", token: tokenFor(51, "support"), body: { status: "closed" },
    });
    assert.strictEqual(r.status, 403, `got ${r.status}`);
  });

  await test("a rider cannot close a ticket", async () => {
    const made = await call("/api/support/tickets", { method: "POST", token: RIDER, body: ok });
    const r = await call(`/api/support/tickets/${made.body.ticket.id}`, {
      method: "PATCH", token: RIDER, body: { status: "closed" },
    });
    assert.strictEqual(r.status, 403);
  });

  await test("an unknown status is refused", async () => {
    const made = await call("/api/support/tickets", { method: "POST", token: RIDER, body: ok });
    const r = await call(`/api/support/tickets/${made.body.ticket.id}`, {
      method: "PATCH", token: tokenFor(50, "admin"), body: { status: "resolved" },
    });
    assert.strictEqual(r.status, 400);
  });

  await test("a ticket that does not exist answers 404", async () => {
    const r = await call("/api/support/tickets/999999", {
      method: "PATCH", token: tokenFor(50, "admin"), body: { status: "closed" },
    });
    assert.strictEqual(r.status, 404);
  });

  await test("an out-of-range ticket id answers 400, not 500", async () => {
    const r = await call("/api/support/tickets/1e12", {
      method: "PATCH", token: tokenFor(50, "admin"), body: { status: "closed" },
    });
    assert.strictEqual(r.status, 400, `got ${r.status}`);
  });

  console.log("");
  console.log("Filtering the queue:");

  await test("status filter narrows the list", async () => {
    const openOnly = await call("/api/support/tickets?status=open", { token: tokenFor(50, "admin") });
    assert.strictEqual(openOnly.status, 200);
    assert.ok(openOnly.body.tickets.every((t) => t.status === "open"), "a closed ticket leaked in");

    const closedOnly = await call("/api/support/tickets?status=closed", { token: tokenFor(50, "admin") });
    assert.ok(closedOnly.body.tickets.every((t) => t.status === "closed"));
    assert.ok(closedOnly.body.tickets.length > 0, "expected at least one closed ticket by now");
  });

  await test("no filter returns everything", async () => {
    const all = await call("/api/support/tickets", { token: tokenFor(50, "admin") });
    const statuses = new Set(all.body.tickets.map((t) => t.status));
    assert.ok(statuses.has("open") && statuses.has("closed"), "expected both states unfiltered");
  });

  await test("a bogus status filter is refused", async () => {
    const r = await call("/api/support/tickets?status=banana", { token: tokenFor(50, "admin") });
    assert.strictEqual(r.status, 400);
  });

  console.log("");
  console.log("Rate limiting the submit endpoint:");

  async function rawPost(token, body) {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/api/support/tickets`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  await test("a rider is cut off after the limit and told why", async () => {
    clearLimit(1);
    const limit = Number(process.env.SUPPORT_TICKET_RATE_LIMIT) || 5;
    for (let i = 0; i < limit; i++) {
      const r = await rawPost(RIDER, ok);
      assert.strictEqual(r.status, 201, `request ${i + 1} should have gone through, got ${r.status}`);
    }
    const blocked = await rawPost(RIDER, ok);
    assert.strictEqual(blocked.status, 429, `expected 429, got ${blocked.status}`);
    assert.ok(blocked.body.error, "429 should carry an { error } message like every other response");
    assert.ok(!/^\s*$/.test(blocked.body.error), "the message should not be blank");
  });

  await test("the limit is per rider, not shared across everyone", async () => {
    // Rider 1 is still blocked from the test above. A different rider must
    // not inherit that, which is what an IP-keyed limit would have done to
    // two people behind the same carrier NAT.
    clearLimit(2);
    const other = await rawPost(OTHER_RIDER, ok);
    assert.strictEqual(other.status, 201, `a second rider should be unaffected, got ${other.status}`);
  });

  await test("reading the queue is not rate limited", async () => {
    for (let i = 0; i < 8; i++) {
      const r = await call("/api/support/tickets", { token: tokenFor(50, "admin") });
      assert.strictEqual(r.status, 200, `admin read ${i + 1} was blocked`);
    }
  });

  server.close();
  console.log(`\n${passed} passed`);
})();
