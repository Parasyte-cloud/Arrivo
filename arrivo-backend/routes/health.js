// Two health endpoints, because "the process is up" and "the app can do its
// job" are different questions and need different reactions.
//
//   GET /healthz   liveness. Answers 200 as long as the process can respond.
//                  Does not touch the database. Point Render's health check
//                  here: if it depended on the database, a database outage
//                  would make Render restart a perfectly healthy API over and
//                  over, which only adds to the outage.
//
//   GET /readyz    readiness. Runs `select 1` against Postgres with a short
//                  timeout and answers 503 if that fails. Point uptime probes
//                  and alerts here: it is the one that says "riders cannot
//                  book right now".
//
// Both return a tiny body with no version, host or error text, because they
// are public. The readiness result is cached for a few seconds so that
// hammering /readyz cannot be used to load the database.
const express = require("express");

function createHealthRouter({ query, timeoutMs = 2000, cacheMs = 5000, log = console.error } = {}) {
  if (typeof query !== "function") throw new Error("createHealthRouter needs a query function");
  const router = express.Router();

  router.get("/healthz", (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({ ok: true });
  });

  let cached = null; // { ok, at }
  let inflight = null;

  function check() {
    if (inflight) return inflight;
    inflight = new Promise((resolve) => {
      const timer = setTimeout(() => {
        log(`readyz: database check timed out after ${timeoutMs}ms`);
        resolve(false);
      }, timeoutMs);
      if (timer.unref) timer.unref();
      Promise.resolve()
        .then(() => query("select 1"))
        .then(() => resolve(true))
        .catch((err) => {
          log("readyz: database check failed:", err && err.message);
          resolve(false);
        })
        .finally(() => clearTimeout(timer));
    }).then((ok) => {
      cached = { ok, at: Date.now() };
      inflight = null;
      return ok;
    });
    return inflight;
  }

  router.get("/readyz", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const fresh = cached && Date.now() - cached.at < cacheMs;
    const ok = fresh ? cached.ok : await check();
    res.status(ok ? 200 : 503).json({ ok });
  });

  return router;
}

module.exports = { createHealthRouter };
