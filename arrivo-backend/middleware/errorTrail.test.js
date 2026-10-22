// Run: node middleware/errorTrail.test.js   (no database or network needed)
const assert = require("assert");
const express = require("express");
const http = require("http");
const { errorTrail, cleanRef, REF_RE } = require("./errorTrail");

const saved = [];
const store = { insert: async (r) => { saved.push(r); }, purge: async () => {} };

const app = express();
app.use(express.json());
app.use(errorTrail({ store }));
app.get("/api/rides/ok", (req, res) => res.json({ ok: true }));
app.post("/api/rides", (req, res) => { req.user = { id: 7, role: "rider" }; res.status(400).json({ error: "scheduledPickupAt must be in the future." }); });
app.post("/api/payments/initialize", (req, res) => res.status(429).json({ error: "Slow down.", code: "rate_limited" }));
app.get("/api/places/x", (req, res) => res.status(400).json({ error: "bad query" }));
app.get("/api/nothing", (req, res) => res.status(404).json({ error: "Not found" }));
app.get("/api/boom", () => { throw new Error("db exploded"); });
app.use((err, req, res, next) => {
  res.locals.errorDetail = err.message;
  res.status(500).json({ error: "Something went wrong on our end. Please try again." });
});

function call(port, method, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ port, method, path, headers: { "Content-Type": "application/json", ...headers } }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data ? JSON.parse(data) : null }));
    });
    req.on("error", reject);
    req.end(method === "POST" ? "{}" : undefined);
  });
}
const tick = () => new Promise((r) => setTimeout(r, 30));

(async () => {
  const srv = app.listen(0);
  const port = srv.address().port;
  try {
    // Success: header only, body untouched, nothing saved.
    let r = await call(port, "GET", "/api/rides/ok");
    assert.ok(REF_RE.test(r.headers["x-request-id"]), "ok response still gets a ref header");
    assert.deepStrictEqual(r.body, { ok: true });

    // Booking 400 from an old app: ref in the body and in the text, saved.
    r = await call(port, "POST", "/api/rides");
    await tick();
    assert.strictEqual(r.status, 400);
    assert.ok(REF_RE.test(r.body.requestId));
    assert.strictEqual(r.body.errorCode, "RIDES_400");
    assert.strictEqual(r.body.error, `scheduledPickupAt must be in the future. (Ref: ${r.body.requestId})`);
    assert.strictEqual(r.headers["x-request-id"], r.body.requestId);
    let row = saved.find((s) => s.ref === r.body.requestId);
    assert.ok(row, "booking failure saved");
    assert.strictEqual(row.userId, 7);
    assert.strictEqual(row.role, "rider");
    assert.strictEqual(row.status, 400);
    assert.strictEqual(row.path, "/api/rides");

    // New app: sends its own ref and build, text left alone, same ref back.
    r = await call(port, "POST", "/api/rides", { "X-Request-Id": "ra-abc234", "X-App-Build": "42", "X-Platform": "android 14", "X-App-Version": "1.0.3" });
    await tick();
    assert.strictEqual(r.body.requestId, "RA-ABC234");
    assert.strictEqual(r.body.error, "scheduledPickupAt must be in the future.");
    row = saved.find((s) => s.ref === "RA-ABC234");
    assert.strictEqual(row.platform, "android 14");
    assert.strictEqual(row.appVersion, "1.0.3");

    // A junk incoming ref is replaced, not trusted.
    r = await call(port, "POST", "/api/rides", { "X-Request-Id": "'; drop table--" });
    assert.notStrictEqual(r.body.requestId, "'; drop table--");
    assert.ok(REF_RE.test(r.body.requestId));

    // Route's own code wins.
    r = await call(port, "POST", "/api/payments/initialize");
    assert.strictEqual(r.body.errorCode, "RATE_LIMITED");

    // 4xx outside booking/payment: ref returned, text untouched, not saved.
    const before = saved.length;
    r = await call(port, "GET", "/api/places/x");
    await tick();
    assert.ok(r.body.requestId);
    assert.strictEqual(r.body.error, "bad query");
    assert.strictEqual(saved.length, before);

    // 404 not saved.
    await call(port, "GET", "/api/nothing");
    await tick();
    assert.strictEqual(saved.length, before);

    // 500: saved with the real message as detail, client only sees the friendly one.
    r = await call(port, "GET", "/api/boom");
    await tick();
    assert.strictEqual(r.status, 500);
    assert.ok(r.body.error.startsWith("Something went wrong on our end."));
    assert.ok(!JSON.stringify(r.body).includes("db exploded"));
    row = saved.find((s) => s.ref === r.body.requestId);
    assert.strictEqual(row.detail, "db exploded");
    assert.strictEqual(row.errorCode, "BOOM_500");

    assert.strictEqual(cleanRef("RA-1OIL00"), null, "confusable characters rejected");
    assert.strictEqual(cleanRef("RA-LLLLLL"), null, "L is never generated, so never accepted");
    console.log("errorTrail: all checks passed");
  } finally {
    srv.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
