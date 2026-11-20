// Realtime event bus.
//
// This is deliberately an in-process Node EventEmitter, not Redis/Kafka/
// NATS. Per spec section 14: don't introduce an external broker without
// first confirming current scale actually requires it. This backend
// currently runs as a single Render web service process (confirmed: no
// cluster config, no pm2, no multi-instance setup found anywhere in the
// codebase) — an in-process emitter is correct for that today.
//
// With more than one Render instance, an in-process emitter only reaches
// Ops users connected to the same instance. So every event is also sent
// through Postgres NOTIFY, and each instance that has a live subscriber
// LISTENs and replays events from the other instances locally. No new
// service needed. Local delivery is unchanged, and an instance skips its
// own notifications so nobody gets an event twice.

const { EventEmitter } = require("events");
const bus = new EventEmitter();
bus.setMaxListeners(0); // many concurrent Ops SSE connections is expected and fine

// Authorized event types only — prevents a typo'd event name from
// silently going nowhere, and gives one place to see the full list spec
// section 15 asks for.
const EVENT_TYPES = new Set([
  "vehicle.location.updated",
  "ride.location.updated",
  "route.changed",
  "route.deviation.started",
  "route.deviation.escalated",
  "route.deviation.resolved",
  "alert.created",
  "alert.updated",
  "vehicle.gps.stale",
  "vehicle.gps.recovered",
]);

const CHANNEL = "arrivo_events";
const INSTANCE_ID = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
const MAX_NOTIFY_BYTES = 7900; // Postgres caps a NOTIFY payload at 8000 bytes

function deliver(event) {
  bus.emit(event.type, event);
  bus.emit("*", event);
}

// Opt in with EVENT_FANOUT=on, set together with the second Render instance.
// Off by default so one instance, local runs and tests behave exactly as before.
function fanoutEnabled() {
  return process.env.EVENT_FANOUT === "on" && !!process.env.DATABASE_URL;
}

function notifyOthers(event) {
  if (!fanoutEnabled()) return;
  const body = JSON.stringify({ from: INSTANCE_ID, event });
  if (Buffer.byteLength(body) > MAX_NOTIFY_BYTES) return; // too big to relay, still delivered here
  require("../../db/db").pool.query("SELECT pg_notify($1, $2)", [CHANNEL, body]).catch(() => {});
}

function publish(eventType, payload) {
  if (!EVENT_TYPES.has(eventType)) {
    throw new Error(`Unknown event type: ${eventType}. Add it to EVENT_TYPES if this is intentional.`);
  }
  const event = { type: eventType, payload, publishedAt: new Date().toISOString() };
  deliver(event);
  notifyOthers(event);
}

// One LISTEN connection per instance, opened when the first subscriber shows up
// and reopened after a dropped connection.
let listener = null;
let connecting = false;
let retryTimer = null;

function handleNotification(msg) {
  if (msg.channel !== CHANNEL) return;
  let data;
  try { data = JSON.parse(msg.payload); } catch { return; }
  if (!data || data.from === INSTANCE_ID || !data.event || !EVENT_TYPES.has(data.event.type)) return;
  deliver(data.event);
}

function scheduleRetry() {
  if (retryTimer) return;
  retryTimer = setTimeout(() => { retryTimer = null; ensureListener(); }, 5000);
  if (retryTimer.unref) retryTimer.unref();
}

async function ensureListener() {
  if (listener || connecting || !fanoutEnabled()) return;
  connecting = true;
  let client;
  try {
    client = await require("../../db/db").pool.connect();
    client.on("notification", handleNotification);
    client.on("error", () => {
      if (listener === client) listener = null;
      try { client.release(true); } catch {}
      if (bus.listenerCount("*") > 0) scheduleRetry();
    });
    await client.query(`LISTEN ${CHANNEL}`);
    listener = client;
  } catch (err) {
    console.error("[events] could not listen for other instances:", err.message);
    if (client) { try { client.release(true); } catch {} }
    scheduleRetry();
  } finally {
    connecting = false;
  }
}

function subscribeAll(handler) {
  bus.on("*", handler);
  ensureListener();
  return () => bus.off("*", handler);
}

module.exports = { EVENT_TYPES, publish, subscribeAll, _test: { handleNotification, INSTANCE_ID, CHANNEL } };
