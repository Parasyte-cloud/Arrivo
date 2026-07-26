const express = require("express");
const { StreamClient } = require("@stream-io/node-sdk");
const { StreamChat } = require("stream-chat");
const { pool } = require("../db/db");
const { requireAuth } = require("../middleware/auth");

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
    clients = getStreamClients();
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
    await clients.video.upsertUsers([{ id: userId, role: "user", name }]);
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

module.exports = router;
// Exported so routes/chat.js can reuse the same lazily-constructed chat
// client instead of building a second one.
module.exports.getStreamClients = getStreamClients;
