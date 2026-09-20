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
const { createWalletFundedRequest, cancelWalletFundedRequest } = require("../services/instantWallet");
const { findDeletionBlocker } = require("../services/accountDeletion");

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
console.log("Apple accounts we cannot revoke for are still allowed to leave:");

// Anyone who signed in with Apple before the refresh token was captured has an
// apple_id and nothing to revoke with. Apple's own deletion guidance says the
// deletion still has to go ahead, and the person is told to remove the app from
// Sign in with Apple themselves. Refusing to delete them is the one thing we
// are not allowed to do.
async function legacyAppleAccount(tag) {
  appleIdentity = { providerId: `apple-${tag}-${stamp}`, email: `apple-${tag}-${stamp}@example.com`, emailVerified: true, audience: RIDER_AUD };
  appleHandler = async () => ({ ok: true, json: async () => ({ refresh_token: "captured-then-lost" }) });
  const signIn = await call("/api/auth/apple", { method: "POST", body: { identityToken: "stub", authorizationCode: "c", agreedToTerms: true } });
  assert.strictEqual(signIn.status, 200, JSON.stringify(signIn.body));
  made.push(signIn.body.user.id);

  // Put the account back the way the old sign-in left it: an apple_id, but no
  // token and no client id.
  await pool.query("UPDATE users SET apple_refresh_token = NULL, apple_client_id = NULL WHERE id = $1", [signIn.body.user.id]);
  appleHandler = null;
  return signIn.body;
}

await test("a legacy Apple account with no stored token can still delete", async () => {
  const account = await legacyAppleAccount("legacy");
  let appleCalled = false;
  appleHandler = async () => { appleCalled = true; return { ok: false, status: 400, text: async () => "" }; };

  const del = await call("/api/auth/me", { method: "DELETE", token: account.token, body: { confirmEmail: account.user.email } });
  assert.strictEqual(del.status, 200, `a legacy Apple account must still be able to leave, got ${del.status}: ${JSON.stringify(del.body)}`);
  assert.strictEqual(del.body.deleted, true);
  assert.strictEqual(del.body.appleManualRevocationRequired, true, "the app has to be told to send them to Settings");
  assert.strictEqual(appleCalled, false, "there was nothing to revoke with, so Apple should not have been called");

  const row = await pool.query("SELECT deleted_at, name, email, apple_id FROM users WHERE id = $1", [account.user.id]);
  assert.ok(row.rows[0].deleted_at, "the account should actually be gone, not just reported gone");
  assert.strictEqual(row.rows[0].name, "Deleted user");
  assert.strictEqual(row.rows[0].apple_id, null, "the Apple link should be cleared on our side");

  const after = await call("/api/auth/me", { token: account.token });
  assert.strictEqual(after.status, 401, "the token should be dead");
  appleHandler = null;
});

await test("a normal account is not told about Apple at all", async () => {
  const u = await signup("noapple");
  const del = await call("/api/auth/me", { method: "DELETE", token: u.token, body: { confirmEmail: u.email } });
  assert.strictEqual(del.status, 200, JSON.stringify(del.body));
  assert.strictEqual(del.body.appleManualRevocationRequired, false, "nothing to do with Apple here");
});

await test("our own missing Apple config cannot trap somebody in their account", async () => {
  const account = await legacyAppleAccount("unconfigured");
  await pool.query("UPDATE users SET apple_refresh_token = 'real-token', apple_client_id = $2 WHERE id = $1", [account.user.id, RIDER_AUD]);

  // A deployment that lost its Apple keys. Their deletion request still wins.
  const keptKey = process.env.APPLE_PRIVATE_KEY;
  process.env.APPLE_PRIVATE_KEY = "";
  try {
    const del = await call("/api/auth/me", { method: "DELETE", token: account.token, body: { confirmEmail: account.user.email } });
    assert.strictEqual(del.status, 200, `a config problem must not block deletion, got ${del.status}: ${JSON.stringify(del.body)}`);
    assert.strictEqual(del.body.appleManualRevocationRequired, true);
  } finally {
    process.env.APPLE_PRIVATE_KEY = keptKey;
  }

  const row = await pool.query("SELECT deleted_at FROM users WHERE id = $1", [account.user.id]);
  assert.ok(row.rows[0].deleted_at, "should be deleted despite the missing config");
});

console.log("");
console.log("Apple sign-in does not quietly create more of them:");

await test("a new Apple account is refused if the exchange gives us nothing", async () => {
  const providerId = `apple-newfail-${stamp}`;
  appleIdentity = { providerId, email: `apple-newfail-${stamp}@example.com`, emailVerified: true, audience: RIDER_AUD };
  appleHandler = async () => ({ ok: false, status: 400, text: async () => "invalid_grant" });

  const r = await call("/api/auth/apple", { method: "POST", body: { identityToken: "stub", authorizationCode: "bad-code", agreedToTerms: true } });
  assert.strictEqual(r.status, 502, `expected a clean refusal, got ${r.status}: ${JSON.stringify(r.body)}`);
  assert.strictEqual(r.body.reason, "apple_authorization_incomplete");

  const row = await pool.query("SELECT id FROM users WHERE apple_id = $1", [providerId]);
  assert.strictEqual(row.rows.length, 0, "a half set up account must not be left behind");
  appleHandler = null;
});

// Losing the Apple keys is our problem, not a reason to start minting
// accounts we will not be able to revoke. The rule is about the missing token,
// not about why it is missing, so it has to hold when the config is gone too.
async function withoutAppleConfig(run) {
  const keptKey = process.env.APPLE_PRIVATE_KEY;
  process.env.APPLE_PRIVATE_KEY = "";
  try {
    return await run();
  } finally {
    process.env.APPLE_PRIVATE_KEY = keptKey;
  }
}

await test("a new Apple account is refused when our Apple config is missing", async () => {
  const providerId = `apple-noconfig-${stamp}`;
  appleIdentity = { providerId, email: `apple-noconfig-${stamp}@example.com`, emailVerified: true, audience: RIDER_AUD };
  let appleCalled = false;
  appleHandler = async () => { appleCalled = true; return { ok: true, json: async () => ({ refresh_token: "never-asked-for" }) }; };

  const r = await withoutAppleConfig(() =>
    call("/api/auth/apple", { method: "POST", body: { identityToken: "stub", authorizationCode: "code-abc", agreedToTerms: true } })
  );

  assert.strictEqual(r.status, 503, `expected a service configuration refusal, got ${r.status}: ${JSON.stringify(r.body)}`);
  assert.strictEqual(r.body.reason, "apple_revocation_unconfigured");
  assert.strictEqual(appleCalled, false, "there are no keys to exchange with, so Apple should not have been called");

  const row = await pool.query("SELECT id FROM users WHERE apple_id = $1", [providerId]);
  assert.strictEqual(row.rows.length, 0, "no account may be created while we cannot capture a revocation token");
  appleHandler = null;
});

await test("an existing Apple account still signs in when our Apple config is missing", async () => {
  const account = await legacyAppleAccount("noconfig-existing");

  const again = await withoutAppleConfig(() =>
    call("/api/auth/apple", { method: "POST", body: { identityToken: "stub", authorizationCode: "code-abc", agreedToTerms: true } })
  );

  assert.strictEqual(again.status, 200, `an existing account must still sign in, got ${again.status}: ${JSON.stringify(again.body)}`);
  assert.strictEqual(again.body.user.id, account.user.id);
});

await test("an existing Apple account still signs in when the exchange fails", async () => {
  const account = await legacyAppleAccount("existing");
  appleHandler = async () => ({ ok: false, status: 400, text: async () => "invalid_grant" });

  // Same person, older build, exchange fails. Locking them out of an account
  // they already have would be worse than the fallback deletion now has.
  const again = await call("/api/auth/apple", { method: "POST", body: { identityToken: "stub", authorizationCode: "bad-code", agreedToTerms: true } });
  assert.strictEqual(again.status, 200, `an existing account must still sign in, got ${again.status}: ${JSON.stringify(again.body)}`);
  assert.strictEqual(again.body.user.id, account.user.id);
  appleHandler = null;
});

console.log("");
console.log("An old build that sends no authorization code at all:");

// The likeliest way this happens in the wild. The refusal has to key off not
// having a token, not off the exchange having been tried and failed.
await test("a new Apple account is refused when no authorization code is sent", async () => {
  const providerId = `apple-nocode-${stamp}`;
  appleIdentity = { providerId, email: `apple-nocode-${stamp}@example.com`, emailVerified: true, audience: RIDER_AUD };
  let appleCalled = false;
  appleHandler = async () => { appleCalled = true; return { ok: true, json: async () => ({ refresh_token: "never" }) }; };

  const r = await call("/api/auth/apple", { method: "POST", body: { identityToken: "stub", agreedToTerms: true } });
  assert.strictEqual(r.status, 502, `expected a refusal, got ${r.status}: ${JSON.stringify(r.body)}`);
  assert.strictEqual(r.body.reason, "apple_authorization_incomplete");
  assert.strictEqual(appleCalled, false, "no code means nothing to exchange");

  const row = await pool.query("SELECT id FROM users WHERE apple_id = $1", [providerId]);
  assert.strictEqual(row.rows.length, 0, "no account may be left behind");
  appleHandler = null;
});

await test("an existing Apple account still signs in with no authorization code", async () => {
  const account = await legacyAppleAccount("nocode-existing");
  const again = await call("/api/auth/apple", { method: "POST", body: { identityToken: "stub", agreedToTerms: true } });
  assert.strictEqual(again.status, 200, `got ${again.status}: ${JSON.stringify(again.body)}`);
  assert.strictEqual(again.body.user.id, account.user.id);
});

await test("a legacy account picks up a token the next time it signs in", async () => {
  // How the no-token population actually drains: they open a current build,
  // sign in, and the exchange finally works. Worth proving, because without it
  // every legacy account stays legacy forever.
  const account = await legacyAppleAccount("selfheal");
  const before = await pool.query("SELECT apple_refresh_token FROM users WHERE id = $1", [account.user.id]);
  assert.strictEqual(before.rows[0].apple_refresh_token, null, "should start with nothing stored");

  appleHandler = async () => ({ ok: true, json: async () => ({ refresh_token: "recovered-token" }) });
  const again = await call("/api/auth/apple", { method: "POST", body: { identityToken: "stub", authorizationCode: "good-code", agreedToTerms: true } });
  assert.strictEqual(again.status, 200, JSON.stringify(again.body));

  const after = await pool.query("SELECT apple_refresh_token, apple_client_id FROM users WHERE id = $1", [account.user.id]);
  assert.strictEqual(after.rows[0].apple_refresh_token, "recovered-token", "the token should now be stored");
  assert.strictEqual(after.rows[0].apple_client_id, RIDER_AUD);
  appleHandler = null;
});

console.log("");
console.log("The ordinary Apple deletion, the one that should just work:");

await test("a revocable Apple account is revoked and deleted, with nothing for the rider to do", async () => {
  appleIdentity = { providerId: `apple-happy-${stamp}`, email: `apple-happy-${stamp}@example.com`, emailVerified: true, audience: RIDER_AUD };
  appleHandler = async () => ({ ok: true, json: async () => ({ refresh_token: "revoke-me" }) });
  const signIn = await call("/api/auth/apple", { method: "POST", body: { identityToken: "stub", authorizationCode: "c", agreedToTerms: true } });
  made.push(signIn.body.user.id);

  let revokeBody = null;
  appleHandler = async (url, options) => {
    if (url.includes("revoke")) { revokeBody = new URLSearchParams(options.body.toString()); return { ok: true, status: 200 }; }
    return { ok: true, json: async () => ({}) };
  };

  const del = await call("/api/auth/me", { method: "DELETE", token: signIn.body.token, body: { confirmEmail: signIn.body.user.email } });
  assert.strictEqual(del.status, 200, JSON.stringify(del.body));
  assert.strictEqual(del.body.appleManualRevocationRequired, false, "we revoked it, so do not send them to Settings");

  assert.ok(revokeBody, "Apple should have been asked to revoke");
  assert.strictEqual(revokeBody.get("token"), "revoke-me", "must revoke the token we stored");
  assert.strictEqual(revokeBody.get("client_id"), RIDER_AUD, "must revoke against the client it was issued to");

  const row = await pool.query("SELECT deleted_at, apple_refresh_token, apple_revoked_at FROM users WHERE id = $1", [signIn.body.user.id]);
  assert.ok(row.rows[0].deleted_at, "should be deleted");
  assert.strictEqual(row.rows[0].apple_refresh_token, null, "the token should be scrubbed too");
  assert.ok(row.rows[0].apple_revoked_at, "a successful revocation has to be written down, or a retry asks Apple twice");
  appleHandler = null;
});

await test("a token with no client id beside it falls back rather than blocking", async () => {
  const account = await legacyAppleAccount("noclient");
  await pool.query("UPDATE users SET apple_refresh_token = 'orphan-token', apple_client_id = NULL WHERE id = $1", [account.user.id]);

  let appleCalled = false;
  appleHandler = async () => { appleCalled = true; return { ok: true, status: 200 }; };
  const del = await call("/api/auth/me", { method: "DELETE", token: account.token, body: { confirmEmail: account.user.email } });

  assert.strictEqual(del.status, 200, `a missing client id must not block deletion, got ${del.status}: ${JSON.stringify(del.body)}`);
  assert.strictEqual(del.body.appleManualRevocationRequired, true);
  assert.strictEqual(appleCalled, false, "we cannot revoke without knowing which client, so do not try");
  appleHandler = null;
});

await test("a network failure talking to Apple still blocks the deletion", async () => {
  appleIdentity = { providerId: `apple-net-${stamp}`, email: `apple-net-${stamp}@example.com`, emailVerified: true, audience: RIDER_AUD };
  appleHandler = async () => ({ ok: true, json: async () => ({ refresh_token: "will-timeout" }) });
  const signIn = await call("/api/auth/apple", { method: "POST", body: { identityToken: "stub", authorizationCode: "c", agreedToTerms: true } });
  made.push(signIn.body.user.id);

  appleHandler = async (url) => { if (url.includes("revoke")) throw new Error("socket hang up"); return { ok: true, json: async () => ({}) }; };
  const del = await call("/api/auth/me", { method: "DELETE", token: signIn.body.token, body: { confirmEmail: signIn.body.user.email } });

  assert.strictEqual(del.status, 502, `a reachable-later failure must not delete, got ${del.status}: ${JSON.stringify(del.body)}`);
  assert.strictEqual(del.body.reason, "apple_revocation_network");

  const row = await pool.query("SELECT deleted_at, deletion_started_at FROM users WHERE id = $1", [signIn.body.user.id]);
  assert.strictEqual(row.rows[0].deleted_at, null, "must not be deleted");
  assert.strictEqual(row.rows[0].deletion_started_at, null, "the in progress mark must be cleared");
  appleHandler = null;
});

console.log("");
console.log("A deletion that revoked Apple and then fell over:");

// Revocation happens before the scrub, and the two cannot be one transaction.
// If the scrub fails, the in progress mark is left set on purpose so a retry
// can finish the job. The retry must not ask Apple to revoke a second time:
// Apple answers invalid_grant for a token that is already dead, we would read
// that as a hard failure, and the account could never finish deleting.
async function halfDeletedAppleAccount(tag) {
  appleIdentity = { providerId: `apple-${tag}-${stamp}`, email: `apple-${tag}-${stamp}@example.com`, emailVerified: true, audience: RIDER_AUD };
  appleHandler = async () => ({ ok: true, json: async () => ({ refresh_token: "already-used" }) });
  const signIn = await call("/api/auth/apple", { method: "POST", body: { identityToken: "stub", authorizationCode: "c", agreedToTerms: true } });
  made.push(signIn.body.user.id);
  appleHandler = null;

  // The state the first attempt leaves behind: Apple revoked, mark still set,
  // nothing scrubbed yet.
  await pool.query("UPDATE users SET deletion_started_at = now(), apple_revoked_at = now() WHERE id = $1", [signIn.body.user.id]);
  return signIn.body;
}

await test("a retry does not ask Apple to revoke twice", async () => {
  const account = await halfDeletedAppleAccount("retry");
  let appleCalled = false;
  appleHandler = async () => { appleCalled = true; return { ok: false, status: 400, text: async () => "invalid_grant" }; };

  const del = await call("/api/auth/me", { method: "DELETE", token: account.token, body: { confirmEmail: account.user.email } });

  assert.strictEqual(del.status, 200, `the retry must finish the job, got ${del.status}: ${JSON.stringify(del.body)}`);
  assert.strictEqual(appleCalled, false, "Apple was already revoked, asking again is what gets the account stuck");
  assert.strictEqual(del.body.appleManualRevocationRequired, false, "we did revoke it, just on the previous attempt");

  const row = await pool.query("SELECT deleted_at FROM users WHERE id = $1", [account.user.id]);
  assert.ok(row.rows[0].deleted_at, "the account should be gone after the retry");
  appleHandler = null;
});

await test("the mark alone does not skip revocation", async () => {
  // Only a recorded revocation skips Apple. An interrupted attempt that never
  // got that far must still revoke on the retry.
  const account = await halfDeletedAppleAccount("markonly");
  await pool.query("UPDATE users SET apple_revoked_at = NULL WHERE id = $1", [account.user.id]);

  let appleCalled = false;
  appleHandler = async (url) => { if (url.includes("revoke")) { appleCalled = true; return { ok: true, status: 200 }; } return { ok: true, json: async () => ({}) }; };

  const del = await call("/api/auth/me", { method: "DELETE", token: account.token, body: { confirmEmail: account.user.email } });
  assert.strictEqual(del.status, 200, JSON.stringify(del.body));
  assert.strictEqual(appleCalled, true, "nothing was revoked yet, so the retry has to do it");
  appleHandler = null;
});

console.log("");
console.log("The router itself:");

await test("no path is registered twice", async () => {
  // Earned this one. A bad edit left two POST /apple handlers in the file and
  // the second never ran, which is invisible until behaviour quietly reverts.
  const seen = new Map();
  for (const layer of authRouter.stack) {
    if (!layer.route) continue;
    for (const method of Object.keys(layer.route.methods)) {
      const key = `${method.toUpperCase()} ${layer.route.path}`;
      seen.set(key, (seen.get(key) || 0) + 1);
    }
  }
  const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([k, n]) => `${k} x${n}`);
  assert.strictEqual(dupes.length, 0, `duplicate handlers: ${dupes.join(", ")}`);
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
console.log("ArrivoExpress holds the fare before there is a ride:");

// ArrivoExpress takes the fare out of the wallet when the request is made,
// long before there is a ride. So the balance reads zero and there is no
// active ride, and both older guards would wave the deletion through. The
// refund would then land on a deleted account, or a driver would accept a
// ride for somebody who no longer exists.
async function openInstantRequest(u) {
  await pool.query("UPDATE users SET wallet_balance_naira = 3000 WHERE id = $1", [u.user.id]);
  const { request } = await createWalletFundedRequest({
    riderId: u.user.id,
    trip: {
      pickupAddress: "Murtala Muhammed Airport", pickupLat: 6.5774, pickupLng: 3.3212,
      destinationAddress: "Victoria Island", destinationLat: 6.4281, destinationLng: 3.4219,
      vehicleType: null, tier: "economy",
    },
    quote: { fareNaira: 3000, distanceKm: 24.5, durationMin: 41 },
  });
  const balance = await pool.query("SELECT wallet_balance_naira FROM users WHERE id = $1", [u.user.id]);
  assert.strictEqual(Number(balance.rows[0].wallet_balance_naira), 0, "fare should have left the wallet");
  return request;
}

await test("a paid ArrivoExpress request blocks deletion", async () => {
  const u = await signup("instant");
  const request = await openInstantRequest(u);

  const del = await call("/api/auth/me", { method: "DELETE", token: u.token, body: { confirmEmail: u.email } });
  assert.strictEqual(del.status, 409, `expected 409, got ${del.status}: ${JSON.stringify(del.body)}`);
  assert.strictEqual(del.body.reason, "active_ride");

  const row = await pool.query("SELECT deleted_at, deletion_started_at FROM users WHERE id = $1", [u.user.id]);
  assert.strictEqual(row.rows[0].deleted_at, null, "deleted while a paid request was open");
  assert.strictEqual(row.rows[0].deletion_started_at, null, "left half way through deleting");

  const still = await pool.query("SELECT status, payment_status FROM instant_ride_requests WHERE id = $1", [request.id]);
  assert.strictEqual(still.rows[0].payment_status, "paid");
});

await test("the app is told up front, before the rider types their email", async () => {
  const u = await signup("instant-pre");
  await openInstantRequest(u);
  const check = await findDeletionBlocker(pool, u.user.id);
  assert.ok(check, "pre-check missed the open request");
  assert.strictEqual(check.reason, "active_ride");
});

await test("once the request is cancelled, the refund is what blocks it", async () => {
  const u = await signup("instant-done");
  const request = await openInstantRequest(u);
  await cancelWalletFundedRequest(u.user.id, request.id);

  const del = await call("/api/auth/me", { method: "DELETE", token: u.token, body: { confirmEmail: u.email } });
  assert.strictEqual(del.status, 409, JSON.stringify(del.body));
  assert.strictEqual(del.body.reason, "wallet_balance", "the refunded fare should be what stops it now");
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
