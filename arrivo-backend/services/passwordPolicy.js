// One place for the password rules, so signup and reset cannot drift apart.
//
// Minimum 8 characters (unchanged, shipped apps already enforce the same).
//
// Maximum 72 BYTES, not characters. bcrypt only ever reads the first 72 bytes
// of its input and ignores the rest. Without a cap, a 200 character password
// looks like it is protected end to end, but any two passwords that share
// their first 72 bytes are the same password to the server. Multi-byte
// characters (accents, emoji) use 2 to 4 bytes each, which is why the limit
// is measured in bytes. The body limit on this API is 6 MB, so without a cap a
// single signup request could also make bcrypt chew on megabytes of input.
//
// Login is deliberately NOT checked against the maximum. Anyone who already
// has a longer password keeps signing in, because bcrypt compares only the
// same first 72 bytes it hashed.

const MIN_PASSWORD_CHARS = 8;
const MAX_PASSWORD_BYTES = 72;

// Returns an error message for the client, or null when the password is fine.
function passwordProblem(password) {
  if (typeof password !== "string") return "Password must be text";
  if (password.length < MIN_PASSWORD_CHARS) {
    return `Password must be at least ${MIN_PASSWORD_CHARS} characters`;
  }
  if (Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) {
    return `Password is too long. Use at most ${MAX_PASSWORD_BYTES} bytes (about ${MAX_PASSWORD_BYTES} plain characters, fewer if it has accents or emoji)`;
  }
  return null;
}

module.exports = { passwordProblem, MIN_PASSWORD_CHARS, MAX_PASSWORD_BYTES };
