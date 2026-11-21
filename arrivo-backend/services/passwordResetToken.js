const crypto = require("crypto");

function hashResetToken(token) {
  return crypto
    .createHash("sha256")
    .update(String(token))
    .digest("hex");
}

function issueResetToken() {
  const token = crypto.randomBytes(32).toString("hex");

  return {
    token,
    storedToken: hashResetToken(token),
  };
}

module.exports = {
  hashResetToken,
  issueResetToken,
};
