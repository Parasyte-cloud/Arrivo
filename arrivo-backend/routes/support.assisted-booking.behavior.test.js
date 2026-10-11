const assert = require("assert");
const crypto = require("crypto");
const http = require("http");
const express = require("express");
require("express-async-errors");

const EMPLOYEE =
  "11111111-1111-4111-8111-111111111111";

const users = [
  {
    id: 1,
    name: "Rider One",
    email: "one@example.com",
    phone: "+2348000000001",
    role: "rider",
  },
  {
    id: 2,
    name: "Rider Two",
    email: "shared@example.com",
    phone: "+2348000000002",
    role: "rider",
  },
  {
    id: 3,
    name: "Rider Three",
    email: "shared@example.com",
    phone: "+2348000000003",
    role: "rider",
  },
];

const assisted = [];
let fareCalls = 0;
let fxCalls = 0;
let rideQueries = 0;

const fakePool = {
  async query(sql, params = []) {
    const q = String(sql)
      .replace(/\s+/g, " ")
      .trim();

    const lower = q.toLowerCase();

    if (
      lower.includes("from users") &&
      lower.includes("where id = $1") &&
      lower.includes("role = 'rider'")
    ) {
      const id = Number(params[0]);

      return {
        rows: users.filter(
          user => user.id === id &&
                  user.role === "rider"
        ),
      };
    }

    if (
      lower.includes("from users") &&
      lower.includes("lower(email)") &&
      lower.includes("phone = $2")
    ) {
      const email =
        String(params[0] || "").toLowerCase();

      const phone =
        String(params[1] || "");

      return {
        rows: users
          .filter(user =>
            user.role === "rider" &&
            (
              (email &&
               user.email.toLowerCase() === email) ||
              (phone && user.phone === phone)
            )
          )
          .slice(0, 3),
      };
    }

    if (
      lower.includes(
        "from support_assisted_bookings"
      ) &&
      lower.includes(
        "where idempotency_key = $1"
      )
    ) {
      const row = assisted.find(
        item =>
          item.idempotency_key === params[0]
      );

      return { rows: row ? [row] : [] };
    }

    if (
      lower.startsWith(
        "insert into support_assisted_bookings"
      )
    ) {
      const row = {
        id: assisted.length + 1,
        ride_id: null,
        rider_id: params[0],
        actor_employee_id: params[1],
        actor_role: params[2],
        actor_request_id: params[3],
        idempotency_key: params[4],
        request_fingerprint: params[5],
        source: params[6],
        payment_method: "card",
        payment_status: params[7],
        payment_status_at_creation: "pending",
        booking_request: JSON.parse(params[8]),
        fare_naira: params[9],
        quoted_ngn_per_usd: params[10],
        quoted_usd_amount: params[11],
      };

      assisted.push(row);
      return { rows: [row] };
    }

    if (
      /\bfrom rides\b/i.test(q) ||
      /\binsert into rides\b/i.test(q) ||
      /\bupdate rides\b/i.test(q)
    ) {
      rideQueries++;
      throw new Error(
        "assisted booking touched rides"
      );
    }

    throw new Error(
      `unexpected query: ${q}`
    );
  },
};

function requireAuth(req, res, next) {
  req.user = {
    id: 900,
    role: "support",
  };

  next();
}

function requireAnyRole(roles) {
  return (req, res, next) =>
    roles.includes(req.user.role)
      ? next()
      : res.status(403).json({
          error: "forbidden",
        });
}

function requireRole(role) {
  return (req, res, next) =>
    req.user.role === role
      ? next()
      : res.status(403).json({
          error: "forbidden",
        });
}

function requireWorkspaceActor(
  req,
  res,
  next
) {
  req.workspaceActor = {
    employeeId: EMPLOYEE,
    role:
      req.get("x-workspace-role") ||
      "support",
    requestId: crypto.randomUUID(),
  };

  next();
}

const dbPath =
  require.resolve("../db/db");

require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: {
    pool: fakePool,
    ready: Promise.resolve(),
  },
};

const authPath =
  require.resolve("../middleware/auth");

require.cache[authPath] = {
  id: authPath,
  filename: authPath,
  loaded: true,
  exports: {
    requireAuth,
    requireAnyRole,
    requireRole,
  },
};

const actorPath =
  require.resolve(
    "../middleware/workspaceActorAuth"
  );

require.cache[actorPath] = {
  id: actorPath,
  filename: actorPath,
  loaded: true,
  exports: { requireWorkspaceActor },
};

const farePath =
  require.resolve("../services/fare");

require.cache[farePath] = {
  id: farePath,
  filename: farePath,
  loaded: true,
  exports: {
    MAX_FULL_DAY_COUNT: 30,

    async computeFare(input) {
      fareCalls++;
      assert.strictEqual(
        input.ngnPerUsd,
        1600
      );
      return 160000;
    },
  },
};

const fxPath =
  require.resolve("../services/fx");

require.cache[fxPath] = {
  id: fxPath,
  filename: fxPath,
  loaded: true,
  exports: {
    async getNgnPerUsd() {
      fxCalls++;
      return 1600;
    },
  },
};

delete require.cache[
  require.resolve("./support")
];

const router = require("./support");

const app = express();
app.use(express.json());
app.use("/api/support", router);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({
    error: "test failure",
  });
});

const server = http.createServer(app);

async function call(body, headers = {}) {
  const { port } = server.address();

  const response = await fetch(
    `http://127.0.0.1:${port}/api/support/assisted-bookings`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    }
  );

  return {
    status: response.status,
    body:
      await response
        .json()
        .catch(() => ({})),
  };
}

const KEY =
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const base = {
  riderId: 1,
  idempotencyKey: KEY,
  bookingType: "one_way",
  vehicleType: "sedan",
  pickupAddress:
    "Murtala Muhammed International Airport",
  destinationAddress:
    "Victoria Island, Lagos",
  flightNumber: "BA123",
  adults: 1,
  children: 0,
  fleetSize: 0,
  securityEscort: false,
  luxury: false,
  agreedCancellationPolicy: true,
};

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS: ${name}`);
    passed++;
  } catch (error) {
    console.log(`FAIL: ${name}`);
    console.log(error.stack || error);
    failed++;
  }
}

(async () => {
  await new Promise(resolve =>
    server.listen(0, "127.0.0.1", resolve)
  );

  try {
    await test(
      "creates pending request without ride",
      async () => {
        const r = await call(base);

        assert.strictEqual(r.status, 201);
        assert.strictEqual(
          r.body.assistedBooking.paymentStatus,
          "pending"
        );
        assert.strictEqual(
          r.body.assistedBooking.rideId,
          null
        );
        assert.strictEqual(
          r.body.assistedBooking
            .requiresCustomerPayment,
          true
        );
        assert.strictEqual(
          r.body.assistedBooking.fareNaira,
          160000
        );
        assert.strictEqual(
          r.body.assistedBooking
            .quotedUsdAmount,
          100
        );
        assert.strictEqual(fareCalls, 1);
        assert.strictEqual(fxCalls, 1);
      }
    );

    await test(
      "exact replay is idempotent",
      async () => {
        const r = await call(base);

        assert.strictEqual(r.status, 200);
        assert.strictEqual(assisted.length, 1);
        assert.strictEqual(fareCalls, 1);
        assert.strictEqual(fxCalls, 1);
      }
    );

    await test(
      "changed request with same key is rejected",
      async () => {
        const r = await call({
          ...base,
          destinationAddress:
            "Lekki Phase 1, Lagos",
        });

        assert.strictEqual(r.status, 409);
        assert.strictEqual(assisted.length, 1);
      }
    );

    await test(
      "ambiguous rider lookup is rejected",
      async () => {
        const r = await call({
          ...base,
          riderId: undefined,
          email: "shared@example.com",
          idempotencyKey:
            "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        });

        assert.strictEqual(r.status, 409);
        assert.strictEqual(assisted.length, 1);
      }
    );

    await test(
      "non-Support Workspace actor is rejected",
      async () => {
        const r = await call(
          {
            ...base,
            idempotencyKey:
              "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          },
          {
            "x-workspace-role":
              "operations",
          }
        );

        assert.strictEqual(r.status, 403);
        assert.strictEqual(assisted.length, 1);
      }
    );

    await test(
      "handler never touches ordinary rides",
      async () => {
        assert.strictEqual(rideQueries, 0);

        assert.ok(
          assisted.every(
            row =>
              row.ride_id === null &&
              row.payment_status === "pending"
          )
        );
      }
    );
  } finally {
    await new Promise(resolve =>
      server.close(resolve)
    );
  }

  console.log(
    `ASSISTED_BOOKING_BEHAVIOR_PASS=${passed}`
  );

  console.log(
    `ASSISTED_BOOKING_BEHAVIOR_FAIL=${failed}`
  );

  if (failed) process.exitCode = 1;
})();
