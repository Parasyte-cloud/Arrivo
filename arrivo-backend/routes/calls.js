const express = require("express");
const { StreamClient } = require("@stream-io/node-sdk");
const { StreamChat } = require("stream-chat");
const { pool } = require("../db/db");
const crypto = require("crypto");
const { requireAuth, requireAnyRole } = require("../middleware/auth");
const { sendPushNotification } = require("../services/pushNotifications");
const rules = require("../services/callRules");

const router = express.Router();

// Lazily constructed — mirrors the pattern used for other optional
// third-party integrations in this codebase (e.g. Paystack's
// PAYSTACK_SECRET_KEY check in routes/payments.js): don't blow up server
// startup if these env vars aren't set yet, only the actual token request
// should fail until they're configured on Render. Video and Chat are two
// separate Stream products but share the SAME app credentials (STREAM_API_KEY/
// STREAM_API_SECRET) — one Stream "app" with both products enabled in its
// dashboard — so no separate Chat-specific env vars are needed.
let streamVideoClient = null;
let streamChatClient = null;
function getStreamClients() {
  if (!process.env.STREAM_API_KEY || !process.env.STREAM_API_SECRET) {
    throw new Error("STREAM_API_KEY/STREAM_API_SECRET are not configured on the server");
  }
  if (!streamVideoClient) {
    streamVideoClient = new StreamClient(process.env.STREAM_API_KEY, process.env.STREAM_API_SECRET);
  }
  if (!streamChatClient) {
    // Chat uses its own server SDK (`stream-chat`, not `@stream-io/node-sdk`)
    // with its own token-signing method — a different package from Video's,
    // even though both run against the same underlying Stream app/keys.
    streamChatClient = StreamChat.getInstance(process.env.STREAM_API_KEY, process.env.STREAM_API_SECRET);
  }
  return { video: streamVideoClient, chat: streamChatClient };
}

// Replaceable in tests so the routes can be exercised without Stream.
let clientsProvider = getStreamClients;

// POST /api/calls/token
// Mints both a Stream Video AND a Stream Chat user token for the current
// user in one call — riders, drivers, AND admin/support staff (the admin
// panel's own calling feature uses this same endpoint; it's role-agnostic,
// keyed purely on req.user.id) — all share the same `users` table and id
// space (see db/schema.sql), so the plain numeric user id is already
// globally unique and safe to use directly as the Stream user_id, no
// per-role prefix needed.
//
// Called by both mobile apps right after login/session-restore, and again
// whenever Stream's SDK asks for a fresh token via its tokenProvider (see
// each app's utils/setPushConfig.js — this is also the endpoint invoked
// from a background push handler with no UI, so it must work purely off
// the bearer token with no other request body). The admin panel calls it
// once per admin session, right before placing an outbound call.
router.post("/token", requireAuth, async (req, res) => {
  let clients;
  try {
    clients = clientsProvider();
  } catch (e) {
    console.error("Stream client not configured:", e.message);
    return res.status(502).json({ error: "Calling isn't set up on the server yet. Please try again later." });
  }

  try {
    const userId = String(req.user.id);
    const userRow = await pool.query("SELECT name FROM users WHERE id = $1", [req.user.id]);
    const name = userRow.rows[0]?.name || undefined;

    // Upsert (not create) — safe to call on every token request, and
    // keeps the display name Stream shows on the call/CallKit UI in sync
    // with any name change made in-app since the user was first upserted.
    // Chat's own upsertUser call is separate from Video's upsertUsers — two
    // distinct products, two distinct user records under the hood, even
    // though they share the same app/keys.
    await clients.video.upsertUsers([{ id: userId, role: streamRoleFor(req.user.role), name }]);
    await clients.chat.upsertUser({ id: userId, name });

    const validitySeconds = 24 * 60 * 60; // matches this app's own JWT-ish session length elsewhere
    const videoToken = clients.video.generateUserToken({ user_id: userId, validity_in_seconds: validitySeconds });
    const chatToken = clients.chat.createToken(userId, Math.floor(Date.now() / 1000) + validitySeconds);

    res.json({ apiKey: process.env.STREAM_API_KEY, userId, videoToken, chatToken });
  } catch (err) {
    console.error("Stream token generation failed:", err.message);
    res.status(502).json({ error: "Could not set up calling right now. Please try again." });
  }
});


// ──────────────────────────────────────────────────────────────────────────
// Ride calls: rider <-> driver, no phone numbers anywhere.
//
// The apps used to create calls themselves, which meant any signed-in user
// could ring any user id. Now the server decides who may call whom (only the
// rider and the assigned driver of a live ride), creates the call, rings the
// other side, and hands the caller a token that only opens that one call.
// Every attempt is recorded in call_sessions so that when a call fails,
// support can see exactly what happened and the person gets a way out.
// ──────────────────────────────────────────────────────────────────────────

// Staff keep Stream's built-in "admin" role so the admin panel can still place
// outbound calls after the "user" role loses permission to create calls
// (see scripts/stream-lockdown.js). Everyone else is a plain "user".
function streamRoleFor(role) {
  return role === "admin" || role === "support" || role === "operations" ? "admin" : "user";
}

function __setStreamClientsForTests(fn) {
  clientsProvider = fn || getStreamClients;
}

const SUPPORT_DIAL = () => process.env.SUPPORT_PHONE_DIAL || "+2348162706078";

// What the app shows when a call cannot be made or did not work. The support
// phone line is the company's own, not a rider's or a driver's.
function supportInfo() {
  const dial = SUPPORT_DIAL();
  return {
    message: "Something went wrong with the call. Talk to our support team. We'll take care of you.",
    inApp: true,
    phone: dial,
    whatsappUrl: `https://wa.me/${dial.replace(/\D/g, "")}`,
  };
}

function firstName(name) {
  return String(name || "").trim().split(/\s+/)[0] || null;
}

async function loadRide(db, rideId) {
  const r = await db.query(
    `SELECT rides.id, rides.rider_id, rides.ride_status, rides.updated_at,
            rider.name AS rider_name, rider.push_token AS rider_push_token,
            drivers.id AS driver_row_id, driver_users.id AS driver_user_id,
            driver_users.name AS driver_name, driver_users.push_token AS driver_push_token
     FROM rides
     JOIN users rider ON rider.id = rides.rider_id
     LEFT JOIN drivers ON drivers.id = rides.driver_id
     LEFT JOIN users driver_users ON driver_users.id = drivers.user_id
     WHERE rides.id = $1`,
    [rideId]
  );
  return r.rows[0] || null;
}

function parseId(value) {
  const n = typeof value === "number" || typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= 2147483647 ? n : null;
}

function publicSession(row) {
  return {
    id: row.id,
    rideId: row.ride_id,
    status: row.status,
    media: row.media,
    createdAt: row.created_at,
    answeredAt: row.answered_at,
    endedAt: row.ended_at,
    durationSeconds: row.duration_seconds,
    failureReason: row.failure_reason,
    supportTicketId: row.support_ticket_id,
  };
}

// GET /api/calls/ride/:rideId/availability
// The app calls this to decide whether to show the call button as active, and
// what to say if it is not. Safe to poll.
router.get("/ride/:rideId/availability", requireAuth, async (req, res) => {
  const rideId = parseId(req.params.rideId);
  if (!rideId) return res.status(400).json({ error: "rideId must be a whole number" });
  const ride = await loadRide(pool, rideId);
  if (!ride) return res.status(404).json({ error: "Ride not found" });
  const role = rules.roleOnRide(ride, req.user.id);
  if (!role) return res.status(403).json({ error: "You're not part of this ride.", code: "not_participant" });

  const a = rules.availability(ride);
  const otherRole = role === "rider" ? "driver" : "rider";
  const otherName = role === "rider" ? ride.driver_name : ride.rider_name;

  // A call already ringing at this person is the thing to answer.
  const live = await pool.query(
    `SELECT * FROM call_sessions WHERE ride_id = $1 AND status IN ('ringing','connected')
     ORDER BY created_at DESC LIMIT 1`,
    [rideId]
  );
  let liveCall = live.rows[0] || null;
  if (liveCall && rules.isStale(liveCall)) liveCall = null;

  res.json({
    canCall: a.canCall,
    code: a.code,
    reason: a.reason,
    you: role,
    counterparty: { role: otherRole, firstName: firstName(otherName) },
    liveCall: liveCall ? { ...publicSession(liveCall), incoming: liveCall.callee_user_id === req.user.id } : null,
    support: supportInfo(),
  });
});

// POST /api/calls/ride/:rideId/start   body: { media?: "audio" | "video" }
router.post("/ride/:rideId/start", requireAuth, async (req, res) => {
  const rideId = parseId(req.params.rideId);
  if (!rideId) return res.status(400).json({ error: "rideId must be a whole number" });
  const media = rules.normaliseMedia(req.body && req.body.media);

  const ride = await loadRide(pool, rideId);
  if (!ride) return res.status(404).json({ error: "Ride not found" });
  const role = rules.roleOnRide(ride, req.user.id);
  if (!role) return res.status(403).json({ error: "You're not part of this ride.", code: "not_participant" });

  const a = rules.availability(ride);
  if (!a.canCall) return res.status(409).json({ error: a.reason, code: a.code, support: supportInfo() });

  const callerId = req.user.id;
  const calleeId = role === "rider" ? Number(ride.driver_user_id) : Number(ride.rider_id);
  const calleeName = role === "rider" ? ride.driver_name : ride.rider_name;
  const calleePush = role === "rider" ? ride.driver_push_token : ride.rider_push_token;

  // Decide, and record the attempt, under a per-ride lock. Two quick taps, or
  // both people dialling each other at once, then cannot create two calls.
  const db = await pool.connect();
  let session;
  let reused = false;
  try {
    await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock(7001, $1)", [rideId]);

    await db.query(
      `UPDATE call_sessions SET status = 'missed', failure_reason = 'ring_timeout', ended_at = now()
       WHERE ride_id = $1 AND status = 'ringing'
         AND created_at < now() - ($2 || ' seconds')::interval`,
      [rideId, String(rules.RING_TIMEOUT_SECONDS + rules.RING_GRACE_SECONDS)]
    );

    const live = await db.query(
      `SELECT * FROM call_sessions WHERE ride_id = $1 AND status IN ('ringing','connected')
       ORDER BY created_at DESC LIMIT 1`,
      [rideId]
    );
    const existing = live.rows[0];
    if (existing) {
      await db.query("COMMIT");
      const incoming = existing.callee_user_id === callerId;
      if (existing.status === "connected") {
        return res.status(409).json({
          error: "You're already on a call for this ride.",
          code: "already_in_call",
          session: publicSession(existing),
          incoming,
        });
      }
      // Ringing. If I started it (double tap) give it back; if the other
      // person started it, I should answer it, not call them back.
      reused = true;
      session = existing;
      if (incoming) {
        return res.status(409).json({
          error: "They're calling you right now. Answer the call instead.",
          code: "incoming_call",
          session: publicSession(existing),
          incoming: true,
        });
      }
    } else {
      const inWindow = await db.query(
        `SELECT count(*)::int AS n FROM call_sessions
         WHERE ride_id = $1 AND caller_user_id = $2
           AND created_at > now() - ($3 || ' minutes')::interval`,
        [rideId, callerId, String(rules.START_WINDOW_MINUTES)]
      );
      const perHour = await db.query(
        `SELECT count(*)::int AS n FROM call_sessions
         WHERE caller_user_id = $1 AND created_at > now() - interval '1 hour'`,
        [callerId]
      );
      if (inWindow.rows[0].n >= rules.MAX_STARTS_PER_RIDE_IN_WINDOW || perHour.rows[0].n >= rules.MAX_STARTS_PER_HOUR) {
        await db.query("ROLLBACK");
        return res.status(429).json({
          error: "That's a lot of calls in a short time. Try again in a few minutes, or talk to support.",
          code: "rate_limited",
          support: supportInfo(),
        });
      }

      const sessionId = crypto.randomUUID();
      const callId = `ride-${rideId}-${crypto.randomUUID()}`;
      const ins = await db.query(
        `INSERT INTO call_sessions (id, ride_id, caller_user_id, callee_user_id, stream_call_id, media)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [sessionId, rideId, callerId, calleeId, callId, media]
      );
      session = ins.rows[0];
      await db.query("COMMIT");
    }
  } catch (err) {
    try { await db.query("ROLLBACK"); } catch (_) {}
    console.error("Call start failed before provisioning:", err.message);
    return res.status(503).json({ error: "We couldn't start the call. Please try again.", code: "try_again", support: supportInfo() });
  } finally {
    db.release();
  }

  // Create the call at the provider and ring the other side.
  let clients;
  try {
    clients = clientsProvider();
  } catch (e) {
    console.error("Stream client not configured:", e.message);
    await markFailed(session.id, "provider_unavailable");
    return res.status(503).json({
      error: "Calling isn't available right now.",
      code: "calling_unavailable",
      sessionId: session.id,
      support: supportInfo(),
    });
  }

  const callerIdStr = String(callerId);
  const calleeIdStr = String(calleeId);
  const callerName = role === "rider" ? ride.rider_name : ride.driver_name;
  try {
    await clients.video.upsertUsers([
      { id: callerIdStr, role: streamRoleFor(req.user.role), name: callerName || undefined },
      { id: calleeIdStr, role: "user", name: calleeName || undefined },
    ]);
    const call = clients.video.call(session.stream_call_type, session.stream_call_id);
    if (!reused) {
      await call.getOrCreate({
        ring: true,
        video: session.media === "video",
        data: {
          created_by_id: callerIdStr,
          members: [{ user_id: callerIdStr }, { user_id: calleeIdStr }],
          custom: { kind: "ride", rideId, sessionId: session.id, callerName: firstName(callerName) },
        },
      });
    }
    const cid = `${session.stream_call_type}:${session.stream_call_id}`;
    const token = clients.video.generateCallToken({
      user_id: callerIdStr,
      call_cids: [cid],
      validity_in_seconds: 60 * 60,
    });

    if (!reused) {
      // A second, ordinary push in case the call ring does not reach a phone
      // that is locked or has the app closed.
      sendPushNotification(
        calleePush,
        role === "rider" ? "Your rider is calling" : "Your driver is calling",
        "Open RideArrivo to answer.",
        { type: "incoming_call", rideId, sessionId: session.id }
      ).catch(() => {});
    }

    res.status(reused ? 200 : 201).json({
      session: publicSession(session),
      call: { type: session.stream_call_type, id: session.stream_call_id },
      join: { apiKey: process.env.STREAM_API_KEY, userId: callerIdStr, token },
      callee: { role: role === "rider" ? "driver" : "rider", firstName: firstName(calleeName) },
      ringTimeoutSeconds: rules.RING_TIMEOUT_SECONDS,
      reused,
      support: supportInfo(),
    });
  } catch (err) {
    console.error("Stream call creation failed:", err.message);
    await markFailed(session.id, "provider_error");
    res.status(502).json({
      error: "We couldn't connect the call.",
      code: "call_failed",
      sessionId: session.id,
      support: supportInfo(),
    });
  }
});

async function markFailed(sessionId, reason) {
  try {
    await pool.query(
      `UPDATE call_sessions SET status = 'failed', failure_reason = $2, ended_at = now()
       WHERE id = $1 AND status IN ('ringing','connected')`,
      [sessionId, String(reason).slice(0, 80)]
    );
  } catch (e) {
    console.error("Could not record call failure:", e.message);
  }
}

// POST /api/calls/:sessionId/events   body: { event, reason? }
// event: connected | ended | missed | declined | cancelled | failed
// Both apps report what they saw. The server decides what is allowed, works
// out the duration itself, and says whether to put support in front of the
// person.
router.post("/:sessionId/events", requireAuth, async (req, res) => {
  const rawEvent = req.body && req.body.event;
  const event = typeof rawEvent === "string" ? rawEvent : "";
  const reason = req.body && req.body.reason ? String(req.body.reason).slice(0, 80) : null;
  if (!rules.EVENTS.has(event)) {
    return res.status(400).json({ error: `event must be one of: ${[...rules.EVENTS].join(", ")}`, code: "unknown_event" });
  }

  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const found = await db.query("SELECT * FROM call_sessions WHERE id = $1 FOR UPDATE", [String(req.params.sessionId)]);
    const session = found.rows[0];
    if (!session) {
      await db.query("ROLLBACK");
      return res.status(404).json({ error: "Call not found" });
    }
    const isCaller = session.caller_user_id === req.user.id;
    const isCallee = session.callee_user_id === req.user.id;
    if (!isCaller && !isCallee) {
      await db.query("ROLLBACK");
      return res.status(403).json({ error: "That isn't your call.", code: "not_participant" });
    }

    // A call nobody reported on and that has rung far too long is missed,
    // whatever this event says.
    let status = session.status;
    if (rules.isStale(session)) status = "missed";

    const t = rules.transition(status, event, isCaller ? "caller" : "callee");
    if (!t.ok) {
      await db.query("ROLLBACK");
      return res.status(409).json({ error: "That doesn't fit where this call is.", code: t.code, session: publicSession(session) });
    }

    let row = session;
    if (t.changed || (status !== session.status && t.next)) {
      const next = t.next;
      const sets = ["status = $2"];
      const args = [session.id, next];
      if (next === "connected") sets.push("answered_at = COALESCE(answered_at, now())");
      if (["ended", "missed", "declined", "cancelled", "failed"].includes(next)) {
        sets.push("ended_at = now()");
        if (session.answered_at || next === "ended") {
          sets.push("duration_seconds = CASE WHEN answered_at IS NULL THEN NULL ELSE GREATEST(0, EXTRACT(EPOCH FROM (now() - answered_at))::int) END");
        }
      }
      if (reason && ["failed", "missed", "declined", "cancelled"].includes(next) && !session.failure_reason) {
        args.push(reason);
        sets.push(`failure_reason = $${args.length}`);
      }
      const upd = await db.query(`UPDATE call_sessions SET ${sets.join(", ")} WHERE id = $1 RETURNING *`, args);
      row = upd.rows[0];
    }

    const recent = await db.query(
      `SELECT status, created_at FROM call_sessions WHERE ride_id = $1 ORDER BY created_at DESC LIMIT 10`,
      [session.ride_id]
    );
    await db.query("COMMIT");

    const wantsSupport = rules.supportSuggested(row.status === "failed" ? "failed" : event, recent.rows);
    res.json({ session: publicSession(row), supportSuggested: wantsSupport, support: wantsSupport ? supportInfo() : undefined });
  } catch (err) {
    try { await db.query("ROLLBACK"); } catch (_) {}
    console.error("Call event failed:", err.message);
    res.status(503).json({ error: "Please try again.", code: "try_again" });
  } finally {
    db.release();
  }
});

// POST /api/calls/:sessionId/support   body: { note? }
// "Talk to support" from the call-failed screen. Opens a support ticket that
// already carries the ride and what happened, so the person does not have to
// explain it. One ticket per call: pressing the button twice returns the same
// ticket. Support can then ring them in the app from the admin panel.
router.post("/:sessionId/support", requireAuth, async (req, res) => {
  const note = String((req.body && req.body.note) || "").trim().slice(0, 500);
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const found = await db.query(
      `SELECT cs.*, rider.name AS rider_name, driver_u.name AS driver_name
       FROM call_sessions cs
       JOIN rides ON rides.id = cs.ride_id
       JOIN users rider ON rider.id = rides.rider_id
       LEFT JOIN drivers ON drivers.id = rides.driver_id
       LEFT JOIN users driver_u ON driver_u.id = drivers.user_id
       WHERE cs.id = $1 FOR UPDATE OF cs`,
      [String(req.params.sessionId)]
    );
    const s = found.rows[0];
    if (!s) {
      await db.query("ROLLBACK");
      return res.status(404).json({ error: "Call not found" });
    }
    if (s.caller_user_id !== req.user.id && s.callee_user_id !== req.user.id) {
      await db.query("ROLLBACK");
      return res.status(403).json({ error: "That isn't your call.", code: "not_participant" });
    }
    if (s.support_ticket_id) {
      await db.query("COMMIT");
      return res.json({ ticketId: s.support_ticket_id, existing: true, support: supportInfo() });
    }

    const who = s.caller_user_id === req.user.id ? "caller" : "person being called";
    const description = [
      `Call problem on ride #${s.ride_id}. Opened from the app by the ${who}.`,
      `Call status: ${s.status}${s.failure_reason ? ` (${s.failure_reason})` : ""}.`,
      `Started: ${new Date(s.created_at).toISOString()}.`,
      note ? `Their note: ${note}` : null,
      "Please contact them in the app. No phone numbers are shared between rider and driver.",
    ].filter(Boolean).join("\n");

    const ticket = await db.query(
      `INSERT INTO support_tickets (user_id, ride_id, type, subject, description)
       VALUES ($1, $2, 'support', $3, $4) RETURNING id`,
      [req.user.id, s.ride_id, `Call problem on ride #${s.ride_id}`, description]
    );
    await db.query("UPDATE call_sessions SET support_ticket_id = $2 WHERE id = $1", [s.id, ticket.rows[0].id]);
    await db.query("COMMIT");
    res.status(201).json({ ticketId: ticket.rows[0].id, existing: false, support: supportInfo() });
  } catch (err) {
    try { await db.query("ROLLBACK"); } catch (_) {}
    console.error("Call support ticket failed:", err.message);
    res.status(503).json({ error: "We couldn't reach support from here. Please try again, or use the support line.", code: "try_again", support: supportInfo() });
  } finally {
    db.release();
  }
});

// GET /api/calls/admin/ride/:rideId  (staff) what happened with calls on a ride.
router.get("/admin/ride/:rideId", requireAuth, requireAnyRole(["admin", "support"]), async (req, res) => {
  const rideId = parseId(req.params.rideId);
  if (!rideId) return res.status(400).json({ error: "rideId must be a whole number" });
  const r = await pool.query(
    `SELECT * FROM call_sessions WHERE ride_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [rideId]
  );
  res.json({ sessions: r.rows.map(publicSession) });
});

module.exports = router;
// Exported so routes/chat.js can reuse the same lazily-constructed chat
// client instead of building a second one.
module.exports.getStreamClients = getStreamClients;
module.exports.__setStreamClientsForTests = __setStreamClientsForTests;
module.exports.streamRoleFor = streamRoleFor;
