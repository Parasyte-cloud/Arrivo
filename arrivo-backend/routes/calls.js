const express = require("express");
const { StreamClient } = require("@stream-io/node-sdk");
const { pool } = require("../db/db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

// Lazily constructed — mirrors the pattern used for other optional
// third-party integrations in this codebase (e.g. Paystack's
// PAYSTACK_SECRET_KEY check in routes/payments.js): don't blow up server
// startup if these env vars aren't set yet, only the actual call-token
// request should fail until they're configured on Render.
let streamClient = null;
function getStreamClient() {
  if (!process.env.STREAM_API_KEY || !process.env.STREAM_API_SECRET) {
    throw new Error("STREAM_API_KEY/STREAM_API_SECRET are not configured on the server");
  }
  if (!streamClient) {
    streamClient = new StreamClient(process.env.STREAM_API_KEY, process.env.STREAM_API_SECRET);
  }
  return streamClient;
}

// POST /api/calls/token
// Mints a Stream Video user token for the current rider or driver (both
// share the same `users` table and id space — see db/schema.sql — so the
// plain numeric user id is already globally unique and safe to use
// directly as the Stream user_id, no per-role prefix needed).
//
// Called by both apps right after login/session-restore, and again
// whenever Stream's SDK asks for a fresh token via its tokenProvider (see
// each app's utils/setPushConfig.js — this is also the endpoint invoked
// from a background push handler with no UI, so it must work purely off
// the bearer token with no other request body).
router.post("/token", requireAuth, async (req, res) => {
  let client;
  try {
    client = getStreamClient();
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
    await client.upsertUsers([{ id: userId, role: "user", name }]);

    const validitySeconds = 24 * 60 * 60; // matches this app's own JWT-ish session length elsewhere
    const token = client.generateUserToken({ user_id: userId, validity_in_seconds: validitySeconds });

    res.json({ apiKey: process.env.STREAM_API_KEY, userId, token });
  } catch (err) {
    console.error("Stream token generation failed:", err.message);
    res.status(502).json({ error: "Could not set up calling right now. Please try again." });
  }
});

module.exports = router;
