const express = require("express");
const router = express.Router();
const { requireAuth, requireRole } = require("../middleware/auth");
const { subscribeAll } = require("../services/telemetry/eventService");

let eventCounter = 0;

// LIMITATION, stated explicitly rather than silently unsupported: this
// implementation does NOT support Last-Event-ID replay. Events carry an
// id so a reconnecting client CAN detect it missed something (its last
// seen id vs. the first id it receives after reconnecting), but there is
// no event store to replay FROM — a missed event is genuinely gone. The
// documented recovery path is what spec section 17 itself allows for:
// reconnect, then request a fresh GET /api/live-map/snapshot rather than
// trying to recover the individual missed events. Adding real replay
// would mean persisting the event stream somewhere durable (Postgres or
// Redis) — a real infrastructure decision, not something to add silently
// as a side effect of this endpoint.

router.get("/", requireAuth, requireRole("admin"), (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  res.write(`event: connected\ndata: ${JSON.stringify({ connectedAt: new Date().toISOString(), replaySupported: false })}\n\n`);

  const unsubscribe = subscribeAll((event) => {
    const id = ++eventCounter;
    res.write(`id: ${id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  });

  const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 25000);

  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

module.exports = router;
