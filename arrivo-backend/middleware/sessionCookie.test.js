// Run: node middleware/sessionCookie.test.js   (no database or network needed)
const assert = require("assert");
const express = require("express");
const http = require("http");
process.env.SESSION_COOKIE_DOMAIN = ".ridearrivo.com";
process.env.NODE_ENV = "production";
const { setSessionCookie, clearSessionCookie, readCookie, csrfOriginCheck } = require("./sessionCookie");

const ALLOWED = ["https://express.ridearrivo.com", "https://ridearrivo.com"];
const app = express();
app.use(csrfOriginCheck(ALLOWED));
app.post("/login", (req, res) => { setSessionCookie(res, "tok.en/1"); res.json({ ok: true }); });
app.post("/logout", (req, res) => { clearSessionCookie(res); res.json({ ok: true }); });
app.post("/act", (req, res) => res.json({ cookie: readCookie(req) }));
app.get("/read", (req, res) => res.json({ cookie: readCookie(req) }));

function call(port, method, path, headers) {
  return new Promise((resolve, reject) => {
    const r = http.request({ port, method, path, headers }, (res) => {
      let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    r.on("error", reject); r.end();
  });
}

(async () => {
  const srv = app.listen(0); const port = srv.address().port;
  const login = await call(port, "POST", "/login", {});
  const set = login.headers["set-cookie"][0];
  assert(/arrivo_session=/.test(set) && /Domain=\.ridearrivo\.com/.test(set) && /HttpOnly/.test(set) && /Secure/.test(set) && /SameSite=Lax/.test(set) && /Path=\//.test(set), "cookie attributes: " + set);
  const cookie = "other=1; arrivo_session=" + encodeURIComponent("tok.en/1");
  assert.strictEqual(JSON.parse((await call(port, "GET", "/read", { cookie })).body).cookie, "tok.en/1");
  assert.strictEqual((await call(port, "POST", "/act", { cookie })).status, 403, "cookie POST without Origin must be refused");
  assert.strictEqual((await call(port, "POST", "/act", { cookie, origin: "https://evil.example" })).status, 403, "foreign origin refused");
  assert.strictEqual((await call(port, "POST", "/act", { cookie, origin: "https://express.ridearrivo.com" })).status, 200, "own origin allowed");
  assert.strictEqual((await call(port, "POST", "/act", { cookie, authorization: "Bearer x" })).status, 200, "Bearer bypasses");
  assert.strictEqual((await call(port, "POST", "/act", {})).status, 200, "no cookie passes");
  const out = (await call(port, "POST", "/logout", { cookie, origin: "https://ridearrivo.com" })).headers["set-cookie"][0];
  assert(/arrivo_session=;/.test(out) && /Domain=\.ridearrivo\.com/.test(out) && /Expires=Thu, 01 Jan 1970/.test(out), "clear cookie: " + out);
  srv.close(); console.log("session cookie tests passed");
})().catch((e) => { console.error(e); process.exit(1); });
