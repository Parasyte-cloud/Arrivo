// Run: node middleware/originLock.test.js   (no database or network needed)
const assert = require("assert");
const express = require("express");
const http = require("http");
const { originLock, HEADER } = require("./originLock");

function build(options) {
  const lines = [];
  const app = express();
  app.use(originLock({ log: (m) => lines.push(m), ...options }));
  app.all("*", (req, res) => res.json({ ok: true }));
  return { app, lines };
}

function call(port, method, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ port, method, path, headers }, (res) => {
      let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => resolve({ status: res.statusCode, body: b }));
    });
    r.on("error", reject); r.end();
  });
}

(async () => {
  let n = 0;
  const check = (cond, msg) => { assert(cond, msg); n++; };
  const SECRET = "s3cret-value-for-tests";

  // off: everything passes, nothing logged
  {
    const { app, lines } = build({ mode: "off", secret: SECRET });
    const srv = app.listen(0); const port = srv.address().port;
    check((await call(port, "GET", "/api/rides")).status === 200, "off lets requests through");
    check(lines.length === 0, "off logs nothing");
    srv.close();
  }

  // default with no environment is off
  {
    const saved = { m: process.env.ORIGIN_LOCK_MODE, s: process.env.ORIGIN_LOCK_SECRET };
    delete process.env.ORIGIN_LOCK_MODE; delete process.env.ORIGIN_LOCK_SECRET;
    const { app } = build({});
    const srv = app.listen(0); const port = srv.address().port;
    check((await call(port, "GET", "/api/rides")).status === 200, "unset environment means off");
    srv.close();
    if (saved.m !== undefined) process.env.ORIGIN_LOCK_MODE = saved.m;
    if (saved.s !== undefined) process.env.ORIGIN_LOCK_SECRET = saved.s;
  }

  // report: passes everything, logs would-block, never logs the secret or query
  {
    const { app, lines } = build({ mode: "report", secret: SECRET });
    const srv = app.listen(0); const port = srv.address().port;
    check((await call(port, "GET", "/api/rides?token=abc")).status === 200, "report lets requests through");
    check(lines.length === 1 && /would block GET \/api\/rides$/.test(lines[0]), "report logs path only: " + lines[0]);
    check((await call(port, "GET", "/api/rides", { [HEADER]: SECRET })).status === 200, "report with right header");
    check(lines.length === 1, "a correct header is not logged");
    check(!lines.join("\n").includes(SECRET), "secret never appears in logs");
    srv.close();
  }

  // enforce: missing and wrong are 403, right is 200, exempt paths pass
  {
    const { app } = build({ mode: "enforce", secret: SECRET, exempt: ["/api/payments/webhook", "/status/"] });
    const srv = app.listen(0); const port = srv.address().port;
    check((await call(port, "GET", "/api/rides")).status === 403, "enforce refuses a missing header");
    check((await call(port, "GET", "/api/rides", { [HEADER]: "wrong" })).status === 403, "enforce refuses a wrong header");
    check((await call(port, "GET", "/api/rides", { [HEADER]: SECRET + "x" })).status === 403, "enforce refuses a near miss");
    check((await call(port, "GET", "/api/rides", { [HEADER]: SECRET })).status === 200, "enforce accepts the right header");
    check((await call(port, "POST", "/api/payments/webhook")).status === 200, "exempt path passes");
    check((await call(port, "POST", "/api/payments/webhook/extra")).status === 200, "below an exempt path passes");
    check((await call(port, "GET", "/status/x")).status === 200, "trailing slash in the list is tolerated");
    check((await call(port, "GET", "/api/payments/webhookish")).status === 403, "prefix match stops at a path boundary");
    const body = JSON.parse((await call(port, "GET", "/api/rides")).body);
    check(body.error === "Forbidden" && Object.keys(body).length === 1, "refusal body reveals nothing");
    srv.close();
  }

  // misconfiguration fails open and says so
  {
    const a = build({ mode: "enforce", secret: "" });
    const srv = a.app.listen(0); const port = srv.address().port;
    check((await call(port, "GET", "/api/rides")).status === 200, "enforce with no secret fails open");
    check(a.lines.some((l) => /SECRET is empty/.test(l)), "and logs why");
    srv.close();

    const b = build({ mode: "banana", secret: SECRET });
    const srv2 = b.app.listen(0); const port2 = srv2.address().port;
    check((await call(port2, "GET", "/api/rides")).status === 200, "unknown mode is off");
    check(b.lines.some((l) => /unknown ORIGIN_LOCK_MODE/.test(l)), "and logs why");
    srv2.close();
  }

  console.log(`${n} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
