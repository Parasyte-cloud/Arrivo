// Startup check for JWT_SECRET.
//
// Every session on this API is an HS256 token signed with this one string. If
// it is short or guessable, anyone can mint a token for any user id and role,
// including admin, without ever touching the database. So the secret needs to
// be long and random.
//
// What happens on a bad value:
//   missing       -> the server refuses to start. Nothing can sign or verify a
//                    token without it, so starting would only fail later and
//                    less clearly.
//   weak          -> a loud warning in the logs on every start. It does NOT stop
//                    the server unless JWT_SECRET_ENFORCE=true. That is on
//                    purpose: if the secret on Render is currently short,
//                    stopping the server on this deploy would take the whole API
//                    down. Rotating the secret also signs every user out. Check
//                    the Render value first, then turn enforcement on.

const MIN_LENGTH = 32;
const PLACEHOLDERS = new Set([
  "secret",
  "changeme",
  "change-me",
  "your_jwt_secret",
  "your-jwt-secret",
  "jwt_secret",
  "jwtsecret",
  "password",
  "test",
]);

// Returns { level: "ok" | "weak" | "missing", reason }.
function assessJwtSecret(secret) {
  if (typeof secret !== "string" || secret.length === 0) {
    return { level: "missing", reason: "JWT_SECRET is not set" };
  }
  if (PLACEHOLDERS.has(secret.trim().toLowerCase())) {
    return { level: "weak", reason: "JWT_SECRET is a well known placeholder value" };
  }
  if (secret.length < MIN_LENGTH) {
    return { level: "weak", reason: `JWT_SECRET is ${secret.length} characters, expected at least ${MIN_LENGTH}` };
  }
  if (new Set(secret).size < 8) {
    return { level: "weak", reason: "JWT_SECRET has very few distinct characters" };
  }
  return { level: "ok", reason: "" };
}

// Called once at startup. `env` and `log` are parameters so tests can drive it.
// Returns true when the server may start, false when it must not.
function checkJwtSecretAtStartup(env = process.env, log = console) {
  const { level, reason } = assessJwtSecret(env.JWT_SECRET);
  if (level === "ok") return true;
  if (level === "missing") {
    log.error(`FATAL: ${reason}. Generate one with: node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`);
    return false;
  }
  if (env.JWT_SECRET_ENFORCE === "true") {
    log.error(`FATAL: ${reason}, and JWT_SECRET_ENFORCE=true. Refusing to start.`);
    return false;
  }
  log.warn(
    `WARNING: ${reason}. Anyone who can guess it can forge a login for any account, admin included. ` +
      `Replace it with at least ${MIN_LENGTH} random characters (this signs everyone out once), ` +
      `then set JWT_SECRET_ENFORCE=true so a weak value can never ship again.`
  );
  return true;
}

module.exports = { assessJwtSecret, checkJwtSecretAtStartup, MIN_LENGTH };
