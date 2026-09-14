// Route-level tests against a REAL Postgres and the real Express app.
//
//   DATABASE_URL=postgres://... node routes/auth.integration.test.js
//   npm run test:integration
//
// These exist because the unit tests could not have caught the bug that made
// them necessary: the Apple token exchange was accidentally sitting inside the
// Google route, so every Google sign-in would have 500'd after creating the
// account. A stand-in pool never exercises the route, so it never noticed.
//
// The concurrency cases run genuinely concurrent transactions rather than
// preconfiguring a fake to return "there is an active ride". That is the only
// way to know the SERIALIZABLE guard actually holds.
//
// Apple is stubbed at the fetch boundary. Everything else is real.

const assert = require("assert");
const crypto = require("crypto");
const http = require("http");

process.env.JWT_SECRET = process.env.JWT_SECRET || "integration-test-secret";
// A throwaway P-256 key so the Apple client secret can really be signed.
const { privateKey } = crypto.generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
process.env.APPLE_TEAM_ID = "TEAM123456";
process.env.APPLE_KEY_ID = "KEY1234567";
process.env.APPLE_PRIVATE_KEY = privateKey.replace(/\n/g, "\\n");

const express = require("express");
require("express-async-errors");
const { pool } = require("../db/db");
const oauth = require("../services/oauth");

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

// Apple's servers are the one thing not real here.
const realFetch = global.fetch;
let appleHandler = null;
global.fetch = async (url, options) => {
  if (String(url).includes("appleid.apple.com") && appleHandler) return appleHandler(String(url), options);
  return realFetch(url, options);
};

// Identity tokens are signed by Apple, which we cannot do, so the verifier is
// stubbed. Everything downstream of it is the real route.
const RIDER_AUD = "com.ridearrivo.rider";
const DRIVER_AUD = "com.ridearrivo.driver";
let appleIdentity = null;
oauth.verifyAppleIdentityToken = async () => {
  if (!appleIdentity) throw new Error("Could not verify this Apple sign-in.");
  return appleIdentity;
};
oauth.verifyGoogleIdToken = async () => ({
  providerId: `google-${Date.now()}`,
  email: `google-${Date.now()}@example.com`,
  emailVerified: true,
  name: "Google User",
});

const authRouter = require("./auth");
const app = express();
app.use(express.json());
app.use("/api/auth", authRouter);
app.use((err, req, res, next) => res.status(500).json({ error: "server error", detail: err.message }));
const server = http.createServer(app);

async function call(path, { method = "GET", token, body } = {}) {
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const stamp = Date.now();
const made = [];
async function signup(tag) {
  const email = `int-${tag}-${stamp}@example.com`;
  const r = await call("/api/auth/signup", {
    method: "POST",
    body: {
      firstName: "Int", lastName: tag, email, password: "hunter2222",
      confirmPassword: "hunter2222", agreedToTerms: true,
    },
  });
  assert.ok(r.body.token, `signup failed: ${JSON.stringify(r.body)}`);
  made.push(r.body.user.id);
  return { ...r.body, email, password: "hunter2222" };
}

(async () => {
await new Promise((r) => server.listen(0, "127.0.0.1", r));

console.log("Google sign-in never touches the Apple exchange:");

await test("google login succeeds and does not 500", async () => {
  // The regression this file was written for. The Apple exchange was in this
  // route, referencing a variable it does not define.
  let appleCalled = false;
  appleHandler = async () => { appleCalled = true; return { ok: true, json: async () => ({ refresh_token: "nope" }) }; };
  const r = await call("/api/auth/google", { method: "POST", body: { idToken: "stub", agreedToTerms: true } });
  assert.strictEqual(r.status, 200, `got ${r.status}: ${JSON.stringify(r.body)}`);
  assert.ok(r.body.token, "should return a token");
  assert.strictEqual(appleCalled, false, "google login must not call Apple");
  if (r.body.user) made.push(r.body.user.id);
  appleHandler = null;
});

console.log("");
console.log("Apple sign-in stores a refresh token against the right client:");

for (const [label, aud] of [["rider", RIDER_AUD], ["driver", DRIVER_AUD]]) {
  await test(`${label} sign-in persists the token and its client id`, async () => {
    appleIdentity = { providerId: `apple-${label}-${stamp}`, email: `apple-${label}-${stamp}@example.com`, emailVerified: true, audience: aud };
    let sawClientId = null;
    appleHandler = async (url, options) => {
      sawClientId = new URLSearchParams(options.body.toString()).get("client_id");
      return { ok: true, json: async () => ({ refresh_token: `refresh-${label}` }) };
    };

    const r = await call("/api/auth/apple", {
      method: "POST",
      body: { identityToken: "stub", authorizationCode: "code-abc", role: label === "driver" ? "driver" : "rider", agreedToTerms: true },
    });
    assert.strictEqual(r.status, 200, `got ${r.status}: ${JSON.stringify(r.body)}`);
    made.push(r.body.user.id);

    assert.strictEqual(sawClientId, aud, "exchange must use the verified audience as the client id");
    const row = await pool.query("SELECT apple_refresh_token, apple_client_id FROM users WHERE id = $1", [r.body.user.id]);
    assert.strictEqual(row.rows[0].apple_refresh_token, `refresh-${label}`, "refresh token should be stored");
    assert.strictEqual(row.rows[0].apple_client_id, aud, "client id should be stored beside it");
    appleHandler = null;
  });
}

await test("the refresh token never reaches the client", async () => {
  appleIdentity = { providerId: `apple-leak-${stamp}`, email: `apple-leak-${stamp}@example.com`, emailVerified: true, audience: RIDER_AUD };
  appleHandler = async () => ({ ok: true, json: async () => ({ refresh_token: "SECRET-TOKEN" }) });
  const r = await call("/api/auth/apple", { method: "POST", body: { identityToken: "stub", authorizationCode: "c", agreedToTerms: true } });
  made.push(r.body.user.id);
  const me = await call("/api/auth/me", { token: r.body.token });
  for (const payload of [JSON.stringify(r.body), JSON.stringify(me.body)]) {
    assert.ok(!payload.includes("SECRET-TOKEN"), "refresh token leaked to the client");
    assert.ok(!payload.includes("apple_refresh_token"), "refresh token field leaked to the client");
  }
  appleHandler = null;
});

console.log("");
console.log("Deleting an account:");

await test("an existing token stops working the moment the account goes", async () => {
  const u = await signup("token");
  const before = await call("/api/auth/me", { token: u.token });
  assert.strictEqual(before.status, 200);
  const del = await call("/api/auth/me", { method: "DELETE", token: u.token, body: { confirmEmail: u.email } });
  assert.strictEqual(del.status, 200, JSON.stringify(del.body));
  const after = await call("/api/auth/me", { token: u.token });
  assert.strictEqual(after.status, 401, `stale token still works: ${after.status}`);
});

await test("an Apple account is not deleted when revocation fails", async () => {
  appleIdentity = { providerId: `apple-fail-${stamp}`, email: `apple-fail-${stamp}@example.com`, emailVerified: true, audience: RIDER_AUD };
  appleHandler = async () => ({ ok: true, json: async () => ({ refresh_token: "will-fail" }) });
  const signIn = await call("/api/auth/apple", { method: "POST", body: { identityToken: "stub", authorizationCode: "c", agreedToTerms: true } });
  const id = signIn.body.user.id;
  made.push(id);

  appleHandler = async (url) => (url.includes("revoke") ? { ok: false, status: 400, text: async () => "invalid_grant" } : { ok: true, json: async () => ({}) });
  const del = await call("/api/auth/me", { method: "DELETE", token: signIn.body.token, body: { confirmEmail: signIn.body.user.email } });
  assert.strictEqual(del.status, 502, `expected 502, got ${del.status}`);

  const row = await pool.query("SELECT deleted_at, deletion_started_at FROM users WHERE id = $1", [id]);
  assert.strictEqual(row.rows[0].deleted_at, null, "account must not be deleted when Apple refused");
  assert.strictEqual(row.rows[0].deletion_started_at, null, "the in progress mark must be cleared again");

  const stillWorks = await call("/api/auth/me", { token: signIn.body.token });
  assert.strictEqual(stillWorks.status, 200, "the account should still be usable");
  appleHandler = null;
});

await test("an account mid-deletion refuses everything but another attempt", async () => {
  const u = await signup("locked");
  await pool.query("UPDATE users SET deletion_started_at = now() WHERE id = $1", [u.user.id]);
  const blocked = await call("/api/auth/me", { token: u.token });
  assert.strictEqual(blocked.status, 423, `expected 423, got ${blocked.status}`);
  assert.strictEqual(blocked.body.reason, "deletion_in_progress");

  const retry = await call("/api/auth/me", { method: "DELETE", token: u.token, body: { confirmEmail: u.email } });
  assert.strictEqual(retry.status, 200, `retry should finish the job, got ${retry.status}`);
});

console.log("");
console.log("Genuinely concurrent, not a fake returning the answer:");

await test("a top-up committing mid-delete does not lose the money", async () => {
  const u = await signup("wallet");
  const a = await pool.connect();
  try {
    await a.query("BEGIN");
    await a.query("UPDATE users SET wallet_balance_naira = 5000 WHERE id = $1", [u.user.id]);
    // The delete now has to queue behind this row lock rather than reading a
    // stale zero balance.
    const del = call("/api/auth/me", { method: "DELETE", token: u.token, body: { confirmEmail: u.email } });
    await new Promise((r) => setTimeout(r, 300));
    await a.query("COMMIT");
    const result = await del;
    assert.strictEqual(result.status, 409, `expected the balance to block it, got ${result.status}`);
    // Either the guard reads the committed balance, or SERIALIZABLE refuses the
    // ordering outright. Both protect the money. Deleting anyway would not.
    assert.ok(
      ["wallet_balance", "concurrent_update"].includes(result.body.reason),
      `unexpected reason: ${result.body.reason}`
    );
  } finally {
    a.release();
  }
  const row = await pool.query("SELECT deleted_at, wallet_balance_naira FROM users WHERE id = $1", [u.user.id]);
  assert.strictEqual(row.rows[0].deleted_at, null, "must not be deleted with money on it");
  assert.strictEqual(Number(row.rows[0].wallet_balance_naira), 5000, "the balance must survive");
  await pool.query("UPDATE users SET wallet_balance_naira = 0 WHERE id = $1", [u.user.id]);
});

await test("a ride created mid-delete is not left with a deleted rider", async () => {
  const u = await signup("ride");
  const a = await pool.connect();
  try {
    await a.query("BEGIN");
    await a.query(
      "INSERT INTO rides (rider_id, pickup_address, fare_naira, ride_status) VALUES ($1, 'Ikeja', 50000, 'in_progress')",
      [u.user.id]
    );
    const del = call("/api/auth/me", { method: "DELETE", token: u.token, body: { confirmEmail: u.email } });
    await new Promise((r) => setTimeout(r, 300));
    await a.query("COMMIT");
    const result = await del;
    // Either the guard sees it, or SERIALIZABLE refuses the ordering. Both are
    // correct; silently deleting is not.
    assert.ok([409].includes(result.status), `expected 409, got ${result.status}: ${JSON.stringify(result.body)}`);
    assert.ok(["active_ride", "concurrent_update"].includes(result.body.reason), result.body.reason);
  } finally {
    a.release();
  }
  const row = await pool.query("SELECT deleted_at FROM users WHERE id = $1", [u.user.id]);
  assert.strictEqual(row.rows[0].deleted_at, null, "must not be deleted with a live ride");
});

console.log("");
console.log("Database trouble is not a login problem:");

await test("an unreadable database answers 503, not 401", async () => {
  const u = await signup("dbfail");
  const original = pool.query.bind(pool);
  pool.query = async (text, params) => {
    if (typeof text === "string" && text.includes("deleted_at, deletion_started_at")) {
      throw Object.assign(new Error("connection terminated"), { code: "57P01" });
    }
    return original(text, params);
  };
  const r = await call("/api/auth/me", { token: u.token });
  pool.query = original;
  assert.strictEqual(r.status, 503, `a database fault must not look like a bad token, got ${r.status}`);
});

await test("a genuinely bad token is still 401", async () => {
  const r = await call("/api/auth/me", { token: "not-a-jwt" });
  assert.strictEqual(r.status, 401);
});

// Leave the database roughly as we found it.
for (const id of [...new Set(made)]) {
  await pool.query("DELETE FROM rides WHERE rider_id = $1", [id]).catch(() => {});
  await pool.query("DELETE FROM users WHERE id = $1", [id]).catch(() => {});
}

server.close();
await pool.end();
console.log(`\n${passed} passed`);
})();
