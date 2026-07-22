// Google + Apple "Sign in with" verification. Both apps (rider and driver)
// send the ID token they got from Google/Apple straight to the backend,
// which verifies it here before ever trusting the email/name inside it —
// never just decode-and-trust a token handed to us by a client.
//
// Needs real credentials the user has to create themselves in Google Cloud
// Console / Apple Developer (same category of setup as GOOGLE_MAPS_SERVER_KEY
// and the Firebase/APNs credentials would be for push) — until then these
// functions throw a clear, actionable error rather than crashing the server,
// same non-blocking-config pattern used elsewhere (services/flights.js,
// services/googleMaps.js).
const { OAuth2Client } = require("google-auth-library");
const jwt = require("jsonwebtoken");
const jwksClient = require("jwks-rsa");

// Comma-separated list of every Google OAuth client ID that's allowed to mint
// tokens we'll accept — typically one per platform per app (iOS, Android, and
// a Web client ID used for the AuthSession flow itself), e.g.:
// "xxxx-ios.apps.googleusercontent.com,xxxx-android.apps.googleusercontent.com,xxxx-web.apps.googleusercontent.com"
function getGoogleClientIds() {
  return (process.env.GOOGLE_OAUTH_CLIENT_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

const googleClient = new OAuth2Client();

// Verifies a Google ID token (the JWT expo-auth-session hands back after a
// successful Google sign-in) and returns the useful bits of its payload.
// Throws if verification fails or GOOGLE_OAUTH_CLIENT_IDS isn't configured.
async function verifyGoogleIdToken(idToken) {
  const audience = getGoogleClientIds();
  if (!audience.length) {
    throw new Error(
      "Google sign-in isn't configured on the server yet (GOOGLE_OAUTH_CLIENT_IDS is missing)."
    );
  }
  const ticket = await googleClient.verifyIdToken({ idToken, audience });
  const payload = ticket.getPayload();
  if (!payload || !payload.sub) throw new Error("Invalid Google token.");
  return {
    providerId: payload.sub,
    email: payload.email || null,
    emailVerified: !!payload.email_verified,
    name: payload.name || [payload.given_name, payload.family_name].filter(Boolean).join(" ") || null,
    avatarUrl: payload.picture || null,
  };
}

// Comma-separated list of bundle IDs allowed as the audience for Apple
// tokens — one per app, e.g. "com.arrivo.app,com.arrivo.driver".
function getAppleBundleIds() {
  return (process.env.APPLE_BUNDLE_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

const appleJwks = jwksClient({
  jwksUri: "https://appleid.apple.com/auth/keys",
  cache: true,
  cacheMaxAge: 12 * 60 * 60 * 1000, // 12h — Apple rotates these rarely
});

function getAppleSigningKey(header, callback) {
  appleJwks.getSigningKey(header.kid, (err, key) => {
    if (err) return callback(err);
    callback(null, key.getPublicKey());
  });
}

// Verifies an Apple identity token (from expo-apple-authentication's
// signInAsync result) against Apple's public keys. Returns the payload's
// stable user id + email. Apple only sends the person's name on the very
// first authorization ever, in a separate `fullName` field the client has to
// capture and forward itself — this function only handles the token.
function verifyAppleIdentityToken(identityToken) {
  const audience = getAppleBundleIds();
  if (!audience.length) {
    throw new Error(
      "Sign in with Apple isn't configured on the server yet (APPLE_BUNDLE_IDS is missing)."
    );
  }
  return new Promise((resolve, reject) => {
    jwt.verify(
      identityToken,
      getAppleSigningKey,
      { algorithms: ["RS256"], audience, issuer: "https://appleid.apple.com" },
      (err, payload) => {
        if (err) return reject(err);
        if (!payload || !payload.sub) return reject(new Error("Invalid Apple token."));
        resolve({
          providerId: payload.sub,
          email: payload.email || null,
          emailVerified: payload.email_verified === true || payload.email_verified === "true",
        });
      }
    );
  });
}

module.exports = { verifyGoogleIdToken, verifyAppleIdentityToken };
