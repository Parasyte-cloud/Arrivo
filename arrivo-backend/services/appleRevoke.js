// Revoking a Sign in with Apple authorization when somebody deletes their
// account. Clearing apple_id on our side only makes us forget them; Apple still
// lists the app under the user's "Sign in with Apple" settings and still holds
// a live authorization. Apple requires the app to actually revoke it, and will
// reject a build that does not.
//
// ── What this needs before it can work ──────────────────────────────────────
//
// Four things, none of which exist in the repo because three of them are
// secrets and one is a key file you download once:
//
//   APPLE_TEAM_ID       10 characters, top right of developer.apple.com
//   APPLE_KEY_ID        10 characters, from the "Sign in with Apple" key
//   APPLE_PRIVATE_KEY   contents of the .p8 file for that key, newlines and all
//
// There is deliberately no APPLE_CLIENT_ID. The client id comes from the
// verified token at sign-in and is stored next to the refresh token, because
// rider and driver are separate Apple clients and a token issued to one
// cannot be revoked with the other.
//
// Create the key at developer.apple.com under Certificates, Identifiers and
// Profiles, Keys, enabling "Sign in with Apple". Apple lets you download the
// .p8 exactly once.
//
// Until those are set, isAppleRevocationConfigured() is false and the caller
// decides what to do about it. It does not fail silently.
//
// ── The other half ──────────────────────────────────────────────────────────
//
// Revoking needs a refresh token, which we only get by exchanging the
// authorization code at sign-in. The apps now send that code and routes/auth.js
// stores the resulting refresh token on the user. Anyone who signed in with
// Apple BEFORE that change has no stored token, so there is nothing to revoke
// for them and they are reported as such rather than quietly passing.

const crypto = require("crypto");
const jwt = require("jsonwebtoken");

const APPLE_TOKEN_URL = "https://appleid.apple.com/auth/token";
const APPLE_REVOKE_URL = "https://appleid.apple.com/auth/revoke";

function config() {
  return {
    teamId: process.env.APPLE_TEAM_ID || "",
    keyId: process.env.APPLE_KEY_ID || "",
    // Env vars cannot hold real newlines, so the .p8 is normally pasted with
    // \n escapes. Turn those back into newlines or the key will not parse.
    privateKey: (process.env.APPLE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
  };
}

function isAppleRevocationConfigured() {
  const c = config();
  return Boolean(c.teamId && c.keyId && c.privateKey);
}

// Apple does not take a static secret. It wants a short-lived ES256 JWT signed
// with the .p8 key, with Apple itself as the audience.
// The client id is passed in, not read from config. Apple ties a refresh
// token to the client that obtained it, and rider and driver are different
// clients, so one global value could only ever revoke one of the two.
function buildClientSecret(clientId) {
  const c = config();
  if (!clientId) throw new Error("An Apple client id is required to build a client secret.");
  const now = Math.floor(Date.now() / 1000);

  return jwt.sign(
    {
      iss: c.teamId,
      iat: now,
      exp: now + 300,
      aud: "https://appleid.apple.com",
      sub: clientId,
    },
    c.privateKey,
    { algorithm: "ES256", keyid: c.keyId }
  );
}

// Swaps the authorization code the app collected at sign-in for a refresh
// token, which is the thing that can later be revoked. Returns null rather than
// throwing when it cannot: failing sign-in because revocation groundwork did
// not work would be the wrong trade.
async function exchangeAuthorizationCode(code, clientId) {
  if (!code || !clientId || !isAppleRevocationConfigured()) return null;

  try {
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: buildClientSecret(clientId),
      code,
      grant_type: "authorization_code",
    });

    const res = await fetch(APPLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    if (!res.ok) return null;
    const data = await res.json().catch(() => ({}));
    return data.refresh_token || null;
  } catch {
    return null;
  }
}

// Tells the caller exactly what happened rather than a bare boolean, because
// "we had nothing to revoke" and "Apple said no" need different handling and
// deletion must not claim success while an authorization is still live.
// clientId is the one persisted alongside the refresh token at sign-in, so
// revocation reuses exactly the client that was authorized.
// Reasons that mean there is nothing to revoke with, as opposed to a
// revocation we tried and that failed. Apple's account deletion guidance is
// explicit that when the refresh token, access token and authorization code
// are all unavailable, the deletion still has to go ahead and the person is
// told to remove the app from Sign in with Apple themselves. Holding their
// account hostage over a token we never captured is not an option.
//
// not_configured sits here for the same reason: our own deployment being
// misconfigured must not be able to permanently trap somebody in an account
// they have asked to leave.
const UNREVOCABLE_REASONS = new Set(["no_token", "no_client_id", "not_configured"]);

async function revokeAppleAuthorization(refreshToken, clientId) {
  if (!isAppleRevocationConfigured()) {
    return { revoked: false, reason: "not_configured" };
  }
  if (!refreshToken) {
    return { revoked: false, reason: "no_token" };
  }
  if (!clientId) {
    return { revoked: false, reason: "no_client_id" };
  }

  try {
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: buildClientSecret(clientId),
      token: refreshToken,
      token_type_hint: "refresh_token",
    });

    const res = await fetch(APPLE_REVOKE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    // Apple answers 200 with an empty body on success.
    if (res.ok) return { revoked: true };

    const detail = await res.text().catch(() => "");
    return { revoked: false, reason: "apple_rejected", status: res.status, detail: detail.slice(0, 300) };
  } catch (error) {
    return { revoked: false, reason: "network", detail: String(error.message || error).slice(0, 300) };
  }
}

module.exports = {
  APPLE_TOKEN_URL,
  UNREVOCABLE_REASONS,
  APPLE_REVOKE_URL,
  isAppleRevocationConfigured,
  buildClientSecret,
  exchangeAuthorizationCode,
  revokeAppleAuthorization,
};
