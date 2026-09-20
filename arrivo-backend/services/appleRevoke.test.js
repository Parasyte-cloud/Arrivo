// Tests for Sign in with Apple revocation. Run directly:
//   node services/appleRevoke.test.js
//
// Generates a throwaway EC key so the client secret can be signed and checked
// for real, and stubs global fetch so Apple is never actually called.
//
// The failure paths matter as much as the happy one here. Apple rejects a build
// that claims deletion while leaving an authorization live, so "we could not
// revoke" has to be distinguishable from "revoked".

const assert = require("assert");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");

// A real P-256 key, so ES256 signing is exercised rather than mocked.
const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

function configure({ withKey = true } = {}) {
  process.env.APPLE_TEAM_ID = withKey ? "TEAM123456" : "";
  process.env.APPLE_KEY_ID = withKey ? "KEY1234567" : "";
  // Stored with escaped newlines, the way an env var has to hold a .p8.
  process.env.APPLE_PRIVATE_KEY = withKey ? privateKey.replace(/\n/g, "\\n") : "";
  process.env.APPLE_BUNDLE_IDS = "com.arrivo.app,com.arrivo.driver";
}

// Rider and driver are separate Apple clients. A refresh token issued to one
// cannot be revoked with the other, which is why the client id is passed in
// per call now instead of read from config.
const RIDER = "com.ridearrivo.rider";
const DRIVER = "com.ridearrivo.driver";

configure();
const {
  isAppleRevocationConfigured,
  buildClientSecret,
  exchangeAuthorizationCode,
  revokeAppleAuthorization,
  APPLE_REVOKE_URL,
  APPLE_TOKEN_URL,
} = require("./appleRevoke");

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

const realFetch = global.fetch;
function stubFetch(handler) {
  const seen = [];
  global.fetch = async (url, options) => {
    seen.push({ url, body: options?.body?.toString() });
    return handler(url, options);
  };
  return seen;
}
const restoreFetch = () => { global.fetch = realFetch; };

(async () => {

console.log("Configuration:");

await test("reports configured when the team, key and .p8 are set", () => {
  configure();
  assert.strictEqual(isAppleRevocationConfigured(), true);
});

await test("reports not configured when the key is missing", () => {
  configure({ withKey: false });
  assert.strictEqual(isAppleRevocationConfigured(), false);
  configure();
});

console.log("");
console.log("The client secret Apple demands:");

await test("is a real ES256 JWT that verifies against the key", () => {
  const secret = buildClientSecret(RIDER);
  const decoded = jwt.verify(secret, publicKey, { algorithms: ["ES256"] });
  assert.strictEqual(decoded.iss, "TEAM123456");
  assert.strictEqual(decoded.sub, RIDER);
  assert.strictEqual(decoded.aud, "https://appleid.apple.com");
});

await test("carries the key id in the header, which Apple requires", () => {
  const header = JSON.parse(Buffer.from(buildClientSecret(RIDER).split(".")[0], "base64").toString());
  assert.strictEqual(header.kid, "KEY1234567");
  assert.strictEqual(header.alg, "ES256");
});

await test("is short lived", () => {
  const decoded = jwt.decode(buildClientSecret(RIDER));
  assert.ok(decoded.exp - decoded.iat <= 300, "should expire within 5 minutes");
});

await test("is signed for whichever app is asking, not one hardcoded app", () => {
  const rider = jwt.verify(buildClientSecret(RIDER), publicKey, { algorithms: ["ES256"] });
  const driver = jwt.verify(buildClientSecret(DRIVER), publicKey, { algorithms: ["ES256"] });
  assert.strictEqual(rider.sub, RIDER);
  assert.strictEqual(driver.sub, DRIVER);
});

await test("refuses to sign without a client id rather than guessing one", () => {
  // Guessing would build a secret Apple rejects, and the failure would show up
  // later as an unexplained revoke error instead of here.
  assert.throws(() => buildClientSecret(""), /client id/i);
  assert.throws(() => buildClientSecret(undefined), /client id/i);
});

console.log("");
console.log("Revoking:");

await test("posts the refresh token to Apple and reports success", async () => {
  const seen = stubFetch(async () => ({ ok: true, status: 200 }));
  const result = await revokeAppleAuthorization("refresh-abc", RIDER);
  restoreFetch();
  assert.deepStrictEqual(result, { revoked: true });
  assert.strictEqual(seen[0].url, APPLE_REVOKE_URL);
  assert.ok(seen[0].body.includes("token=refresh-abc"));
  assert.ok(seen[0].body.includes("token_type_hint=refresh_token"));
});

await test("a rejection from Apple is reported, not swallowed", async () => {
  stubFetch(async () => ({ ok: false, status: 400, text: async () => "invalid_grant" }));
  const result = await revokeAppleAuthorization("refresh-abc", RIDER);
  restoreFetch();
  assert.strictEqual(result.revoked, false);
  assert.strictEqual(result.reason, "apple_rejected");
  assert.strictEqual(result.status, 400);
});

await test("a network failure is reported, not swallowed", async () => {
  stubFetch(async () => { throw new Error("socket hang up"); });
  const result = await revokeAppleAuthorization("refresh-abc", RIDER);
  restoreFetch();
  assert.strictEqual(result.revoked, false);
  assert.strictEqual(result.reason, "network");
});

await test("no stored token is its own outcome, not a success", async () => {
  const result = await revokeAppleAuthorization(null, RIDER);
  assert.strictEqual(result.revoked, false);
  assert.strictEqual(result.reason, "no_token");
});

await test("missing configuration is its own outcome, not a success", async () => {
  configure({ withKey: false });
  const result = await revokeAppleAuthorization("refresh-abc", RIDER);
  configure();
  assert.strictEqual(result.revoked, false);
  assert.strictEqual(result.reason, "not_configured");
});

await test("no stored client id is its own outcome, not a success", async () => {
  // Anyone who signed in before the client id was stored has a refresh token we
  // cannot revoke. Saying so beats revoking with the wrong app's identity.
  const result = await revokeAppleAuthorization("refresh-abc", null);
  assert.strictEqual(result.revoked, false);
  assert.strictEqual(result.reason, "no_client_id");
});

await test("revokes against the client the token was issued to", async () => {
  const seen = stubFetch(async () => ({ ok: true, status: 200 }));
  await revokeAppleAuthorization("driver-token", DRIVER);
  restoreFetch();
  assert.ok(seen[0].body.includes(`client_id=${encodeURIComponent(DRIVER)}`));
  const secret = new URLSearchParams(seen[0].body).get("client_secret");
  assert.strictEqual(jwt.decode(secret).sub, DRIVER);
});

await test("never reports revoked without Apple actually saying so", async () => {
  // The whole point: every failure path above must be falsy on `revoked`, or
  // deletion would claim completion with a live Apple authorization.
  for (const outcome of [
    await revokeAppleAuthorization(null, RIDER),
    await (async () => { stubFetch(async () => ({ ok: false, status: 500, text: async () => "" })); const r = await revokeAppleAuthorization("t", RIDER); restoreFetch(); return r; })(),
    await (async () => { stubFetch(async () => { throw new Error("down"); }); const r = await revokeAppleAuthorization("t", RIDER); restoreFetch(); return r; })(),
  ]) {
    assert.strictEqual(outcome.revoked, false);
    assert.ok(outcome.reason, "a failure must say why");
  }
});

console.log("");
console.log("Exchanging the authorization code at sign-in:");

await test("returns the refresh token Apple hands back", async () => {
  const seen = stubFetch(async () => ({ ok: true, json: async () => ({ refresh_token: "r-123" }) }));
  const token = await exchangeAuthorizationCode("code-abc", RIDER);
  restoreFetch();
  assert.strictEqual(token, "r-123");
  assert.strictEqual(seen[0].url, APPLE_TOKEN_URL);
  assert.ok(seen[0].body.includes("grant_type=authorization_code"));
});

await test("returns null rather than throwing when Apple refuses", async () => {
  stubFetch(async () => ({ ok: false, status: 400 }));
  assert.strictEqual(await exchangeAuthorizationCode("code-abc", RIDER), null);
  restoreFetch();
});

await test("returns null rather than throwing when the network fails", async () => {
  stubFetch(async () => { throw new Error("down"); });
  assert.strictEqual(await exchangeAuthorizationCode("code-abc", RIDER), null);
  restoreFetch();
});

await test("exchanges against the app that signed in", async () => {
  const seen = stubFetch(async () => ({ ok: true, json: async () => ({ refresh_token: "r-driver" }) }));
  const token = await exchangeAuthorizationCode("code-abc", DRIVER);
  restoreFetch();
  assert.strictEqual(token, "r-driver");
  assert.ok(seen[0].body.includes(`client_id=${encodeURIComponent(DRIVER)}`));
});

await test("does nothing without a client id, same as without a code", async () => {
  stubFetch(async () => ({ ok: true, json: async () => ({ refresh_token: "r-123" }) }));
  assert.strictEqual(await exchangeAuthorizationCode("code-abc", null), null);
  restoreFetch();
});

await test("does nothing without a code, so other sign-ins are unaffected", async () => {
  assert.strictEqual(await exchangeAuthorizationCode(null, RIDER), null);
  assert.strictEqual(await exchangeAuthorizationCode("", RIDER), null);
});

console.log(`\n${passed} passed`);
})();
