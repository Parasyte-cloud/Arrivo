// Service-to-service authentication for the wallet API (/api/internal/wallet).
//
// Another Arrivo service (ArrivoExpress first) proves who it is by signing every
// request with a secret only that service and this API know. Nothing is sent
// that could be replayed later: the signature covers the timestamp, the method,
// the full path with its query and a hash of the body, and a request older than five minutes is
// refused.
//
//   X-Service:   the service name, for example "express"
//   X-Timestamp: seconds since 1970
//   X-Signature: hex HMAC-SHA256 of  timestamp \n METHOD \n path \n sha256(body)
//
// The secret for a service lives in WALLET_SERVICE_SECRET_<SERVICE> (for example
// WALLET_SERVICE_SECRET_EXPRESS) and is never in code or in a response. The
// service name is taken from the verified header only, never from the body, so
// one service can never act as another.

const crypto = require("crypto");
const express = require("express");

const MAX_SKEW_SECONDS = 300;
const KNOWN_SERVICES = ["express"];

function secretFor(service) {
  if (!KNOWN_SERVICES.includes(service)) return null;
  const secret = process.env[`WALLET_SERVICE_SECRET_${service.toUpperCase()}`];
  return secret && secret.length >= 32 ? secret : null;
}

function bodyHash(raw) {
  return crypto.createHash("sha256").update(raw || "").digest("hex");
}

function sign({ secret, timestamp, method, path, rawBody }) {
  return crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}\n${String(method).toUpperCase()}\n${path}\n${bodyHash(rawBody)}`)
    .digest("hex");
}

function safeEqualHex(a, b) {
  const x = Buffer.from(String(a), "utf8");
  const y = Buffer.from(String(b), "utf8");
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const readRaw = express.raw({ type: () => true, limit: "32kb" });

function requireService(req, res, next) {
  readRaw(req, res, (err) => {
    if (err) return res.status(400).json({ error: "Unreadable body", code: "BAD_BODY" });
    const service = String(req.get("x-service") || "").toLowerCase();
    const timestamp = String(req.get("x-timestamp") || "");
    const signature = String(req.get("x-signature") || "");
    const secret = secretFor(service);
    // One generic answer for every failure, so a caller learns nothing about why.
    const deny = () => res.status(401).json({ error: "Service authentication failed", code: "SERVICE_AUTH" });
    if (!secret || !/^\d{9,12}$/.test(timestamp) || !signature) return deny();
    if (Math.abs(Date.now() / 1000 - Number(timestamp)) > MAX_SKEW_SECONDS) return deny();
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    // The whole URL is signed, query string included, so a captured request cannot be replayed with a different filter.
    const path = req.originalUrl;
    const expected = sign({ secret, timestamp, method: req.method, path, rawBody: raw });
    if (!safeEqualHex(expected, signature)) return deny();
    try {
      req.body = raw.length ? JSON.parse(raw.toString("utf8")) : {};
    } catch {
      return res.status(400).json({ error: "Body must be JSON", code: "BAD_BODY" });
    }
    req.service = service;
    next();
  });
}

module.exports = { requireService, sign, secretFor, KNOWN_SERVICES, MAX_SKEW_SECONDS };
