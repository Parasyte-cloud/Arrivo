// Run: node routes/health.test.js   (no database or network needed)
const assert = require("assert");
const express = require("express");
const http = require("http");
const { createHealthRouter } = require("./health");

function serve(router) {
  const app = express();
  app.use(router);
  const srv = app.listen(0);
  return { srv, port: srv.address().port };
}

function get(port, path) {
  return new Promise((resolve, reject) => {
    http.get({ port, path }, (res) => {
      let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(b), headers: res.headers }));
    }).on("error", reject);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let n = 0;
  const check = (cond, msg) => { assert(cond, msg); n++; };
  const quiet = () => {};

  // healthz never touches the database
  {
    let calls = 0;
    const { srv, port } = serve(createHealthRouter({ query: async () => { calls++; throw new Error("db down"); }, log: quiet }));
    const r = await get(port, "/healthz");
    check(r.status === 200 && r.body.ok === true, "healthz is 200");
    check(calls === 0, "healthz does not query the database");
    check(r.headers["cache-control"] === "no-store", "healthz is not cached");
    srv.close();
  }

  // readyz ok
  {
    const { srv, port } = serve(createHealthRouter({ query: async () => ({ rows: [{ "?column?": 1 }] }), log: quiet }));
    const r = await get(port, "/readyz");
    check(r.status === 200 && r.body.ok === true, "readyz is 200 when the query works");
    srv.close();
  }

  // readyz fails: 503 and no error detail in the body
  {
    const { srv, port } = serve(createHealthRouter({ query: async () => { throw new Error("password authentication failed for user x"); }, log: quiet }));
    const r = await get(port, "/readyz");
    check(r.status === 503 && r.body.ok === false, "readyz is 503 when the query fails");
    check(Object.keys(r.body).length === 1, "failure body leaks nothing");
    srv.close();
  }

  // readyz times out
  {
    const { srv, port } = serve(createHealthRouter({ query: () => new Promise(() => {}), timeoutMs: 50, log: quiet }));
    const t = Date.now();
    const r = await get(port, "/readyz");
    check(r.status === 503, "readyz is 503 when the query hangs");
    check(Date.now() - t < 1000, "and it answers quickly");
    srv.close();
  }

  // caching: repeat calls inside the window reuse the answer, then refresh
  {
    let calls = 0;
    const { srv, port } = serve(createHealthRouter({ query: async () => { calls++; }, cacheMs: 80, log: quiet }));
    await get(port, "/readyz"); await get(port, "/readyz"); await get(port, "/readyz");
    check(calls === 1, "three quick calls cause one database query, got " + calls);
    await sleep(120);
    await get(port, "/readyz");
    check(calls === 2, "after the window it checks again, got " + calls);
    srv.close();
  }

  // concurrent calls share one in-flight query
  {
    let calls = 0;
    const { srv, port } = serve(createHealthRouter({ query: () => new Promise((r) => { calls++; setTimeout(r, 40); }), cacheMs: 0, log: quiet }));
    await Promise.all([get(port, "/readyz"), get(port, "/readyz"), get(port, "/readyz")]);
    check(calls === 1, "concurrent calls share one query, got " + calls);
    srv.close();
  }

  // factory refuses a missing query function
  assert.throws(() => createHealthRouter({}), /query function/); n++;

  console.log(`${n} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
