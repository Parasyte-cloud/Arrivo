// Run: node middleware/secureHeaders.test.js   (no database or network needed)
const assert = require("assert");
const express = require("express");
const http = require("http");
const { secureHeaders } = require("./secureHeaders");

const app = express();
app.set("trust proxy", 1);
app.use(secureHeaders());
app.get("/api/thing", (req, res) => res.json({ ok: true }));
app.get("/api/stream", (req, res) => { res.set("Cache-Control", "no-cache"); res.json({ ok: true }); });
app.get("/page", (req, res) => res.send("hi"));

function get(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ port, path, headers }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.headers));
    }).on("error", reject);
  });
}

(async () => {
  const srv = app.listen(0);
  const port = srv.address().port;
  let n = 0;
  const check = (cond, msg) => { assert(cond, msg); n++; };

  const plain = await get(port, "/api/thing");
  check(plain["x-content-type-options"] === "nosniff", "nosniff");
  check(plain["referrer-policy"] === "no-referrer", "referrer policy");
  check(plain["x-frame-options"] === "DENY", "frame options");
  check(/geolocation=\(\)/.test(plain["permissions-policy"]), "permissions policy");
  check(plain["cache-control"] === "no-store", "api responses are not cached");
  check(!plain["strict-transport-security"], "no HSTS over plain http");

  const secure = await get(port, "/api/thing", { "x-forwarded-proto": "https" });
  check(/max-age=31536000/.test(secure["strict-transport-security"]), "HSTS when the original request was https");

  const page = await get(port, "/page");
  check(!page["cache-control"] || page["cache-control"] !== "no-store", "non-api paths keep default caching");

  const override = await get(port, "/api/stream");
  check(override["cache-control"] === "no-cache", "a route can override Cache-Control");

  srv.close();
  console.log(`${n} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
