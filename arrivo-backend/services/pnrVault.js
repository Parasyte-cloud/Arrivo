// Stores a booking code (PNR) encrypted, so a database dump, a log line or an API list never holds
// it in the clear. AES-256-GCM with the ride id bound in as associated data, so a ciphertext copied
// onto another ride fails to decrypt.
//
// Set FLIGHT_PNR_KEY to 32 random bytes, base64 (openssl rand -base64 32). With no key the vault
// refuses to store anything: a PNR is optional, so failing closed beats storing it in the clear.
const crypto = require("crypto");

function key() {
  const raw = process.env.FLIGHT_PNR_KEY || "";
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== 32) {
    const err = new Error("FLIGHT_PNR_KEY is not set to 32 base64 bytes");
    err.code = "PNR_KEY_MISSING";
    throw err;
  }
  return buf;
}

const available = () => { try { key(); return true; } catch { return false; } };

function seal(plain, rideId) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key(), iv);
  c.setAAD(Buffer.from(`ride:${rideId}`));
  const ct = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
  return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}

function open(sealed, rideId) {
  const [v, iv, tag, ct] = String(sealed || "").split(".");
  if (v !== "v1" || !iv || !tag || !ct) throw new Error("Unrecognised PNR record");
  const d = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
  d.setAAD(Buffer.from(`ride:${rideId}`));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
}

module.exports = { seal, open, available };
