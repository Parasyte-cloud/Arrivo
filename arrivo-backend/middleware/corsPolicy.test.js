const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");
const cors = require("cors");
const { makeOriginCheck, respondIfCorsRejection } = require("./corsPolicy");

// Same wiring as server.js: the real cors package, the real origin check, the
// real rejection handler, over real HTTP.
function start() {
  const app = express();
  app.use(cors({ credentials: true, origin: makeOriginCheck(["https://ridearrivo.com"]) }));
  app.get("/ping", (req, res) => res.json({ ok: true }));
  app.use((err, req, res, next) => {
    if (respondIfCorsRejection(err, res)) return;
    res.status(err.status || 500).json({ error: "generic" });
  });
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

function get(server, headers) {
  return new Promise((resolve, reject) => {
    http
      .get({ port: server.address().port, path: "/ping", headers }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(body), headers: res.headers }));
      })
      .on("error", reject);
  });
}

test("a browser from an unknown origin gets 403, not 500", async () => {
  const server = await start();
  try {
    const r = await get(server, { Origin: "https://evil.example" });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "This origin is not allowed.");
    assert.equal(r.headers["access-control-allow-origin"], undefined);
  } finally {
    server.close();
  }
});

test("an allowed origin passes and is echoed", async () => {
  const server = await start();
  try {
    const r = await get(server, { Origin: "https://ridearrivo.com" });
    assert.equal(r.status, 200);
    assert.equal(r.headers["access-control-allow-origin"], "https://ridearrivo.com");
  } finally {
    server.close();
  }
});

test("a request with no Origin (the mobile apps) always passes", async () => {
  const server = await start();
  try {
    const r = await get(server, {});
    assert.equal(r.status, 200);
  } finally {
    server.close();
  }
});

test("other errors still fall through to the generic handler", () => {
  let sent = false;
  const res = { status: () => res, json: () => (sent = true) };
  assert.equal(respondIfCorsRejection(new Error("boom"), res), false);
  assert.equal(sent, false);
});
