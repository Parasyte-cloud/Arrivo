const express = require("express");
const rateLimit = require("express-rate-limit");
const { pool } = require("../db/db");
const { requireAuth, requireRole, requireAnyRole } = require("../middleware/auth");

const router = express.Router();

const TYPES = ["complaint", "inquiry", "support"];
const STATUSES = ["open", "closed"];

// Anyone signed in can file a ticket, so the only thing standing between us
// and a loop is this. Keyed by user id rather than IP on purpose: riders here
// are on mobile networks that put a lot of people behind one carrier NAT
// address, and an IP key would have strangers throttling each other.
// requireAuth runs before this, so req.user is always set.
//
// Only the write path is limited. The list and close routes are admin and
// support only, which is a much smaller and known set of people.
const submitLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.SUPPORT_TICKET_RATE_LIMIT) || 5,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => String(req.user.id),
  // The default handler answers in plain text. Everything else in this API
  // answers { error }, and the app reads that field to show a message.
  handler: (req, res) =>
    res.status(429).json({
      error:
        "That's a lot of messages in a short time. Give it a few minutes, or call us if it's urgent.",
    }),
});
const MAX_SUBJECT = 140;
const MAX_DESCRIPTION = 4000;

// POST /api/support/tickets
// body: { type, subject, description, rideId? }
router.post("/tickets", requireAuth, submitLimiter, async (req, res) => {
  const { type, subject, description, rideId } = req.body;

  if (!TYPES.includes(type)) {
    return res.status(400).json({ error: `type must be one of: ${TYPES.join(", ")}` });
  }

  const cleanSubject = String(subject || "").trim();
  const cleanDescription = String(description || "").trim();
  if (!cleanSubject) return res.status(400).json({ error: "subject is required" });
  if (cleanSubject.length > MAX_SUBJECT) {
    return res.status(400).json({ error: `subject must be ${MAX_SUBJECT} characters or fewer` });
  }
  if (!cleanDescription) return res.status(400).json({ error: "description is required" });
  if (cleanDescription.length > MAX_DESCRIPTION) {
    return res.status(400).json({ error: `description must be ${MAX_DESCRIPTION} characters or fewer` });
  }

  // The app sends the rider's latest booking id so support has context, but
  // don't just trust it. Two reasons: a bad id would hit an INTEGER column and
  // blow up as a 500 instead of a clean 400, and without the owner check you
  // could file a ticket against someone else's trip.
  let attachedRideId = null;
  if (rideId !== undefined && rideId !== null && rideId !== "") {
    // Coerce only from a number or a numeric string. Number(true) is 1 and
    // Number([7]) is 7, so a plain Number() here would turn a malformed
    // value into a real id and quietly attach a ride nobody named. Upper
    // bound is Postgres's INTEGER max: anything past it reaches the column
    // and throws, which is the 500 this block exists to avoid.
    const asNumber =
      typeof rideId === "number" || typeof rideId === "string" ? Number(rideId) : NaN;
    if (!Number.isInteger(asNumber) || asNumber < 1 || asNumber > 2147483647) {
      return res.status(400).json({ error: "rideId must be a whole number" });
    }
    const owned = await pool.query("SELECT id FROM rides WHERE id = $1 AND rider_id = $2", [
      asNumber,
      req.user.id,
    ]);
    if (!owned.rows[0]) return res.status(400).json({ error: "That booking isn't on your account." });
    attachedRideId = owned.rows[0].id;
  }

  const result = await pool.query(
    `INSERT INTO support_tickets (user_id, ride_id, type, subject, description)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [req.user.id, attachedRideId, type, cleanSubject, cleanDescription]
  );
  res.status(201).json({ ticket: result.rows[0] });
});

// GET /api/support/tickets. Ops only, newest first.
// Nothing in the admin dashboard reads this yet. It's here so tickets aren't
// write-only until that page gets built.
router.get("/tickets", requireAuth, requireAnyRole(["admin", "support"]), async (req, res) => {
  // Optional ?status= filter. It matters more than it looks: the list is
  // capped at 200 and ordered newest first, so once enough closed tickets
  // pile up an open one would drop off the end and never be seen again.
  const { status } = req.query;
  if (status !== undefined && !STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${STATUSES.join(", ")}` });
  }

  const result = await pool.query(
    `SELECT support_tickets.*,
            users.name AS user_name,
            users.email AS user_email,
            users.phone AS user_phone
     FROM support_tickets
     JOIN users ON users.id = support_tickets.user_id
     WHERE ($1::text IS NULL OR support_tickets.status = $1)
     ORDER BY support_tickets.created_at DESC
     LIMIT 200`
    , [status === undefined ? null : status]
  );
  res.json({ tickets: result.rows });
});

// PATCH /api/support/tickets/:id  body: { status }
// Closing is a mutation, so it needs admin specifically. The router-level
// requireAnyRole above lets support READ the queue, and per the roles note in
// ENGINEERING.md that read-only split is not automatic: every mutating route
// has to check for admin itself, which is what requireRole does here.
router.patch("/tickets/:id", requireAuth, requireRole("admin"), async (req, res) => {
  const { status } = req.body;
  if (!STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${STATUSES.join(", ")}` });
  }

  const id = Number(req.params.id);
  // Same bound as the rideId check above: past INTEGER range the value
  // reaches the column and throws a 500 instead of answering cleanly.
  if (!Number.isInteger(id) || id < 1 || id > 2147483647) {
    return res.status(400).json({ error: "That ticket id is not valid." });
  }

  const result = await pool.query(
    "UPDATE support_tickets SET status = $1 WHERE id = $2 RETURNING *",
    [status, id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: "No ticket with that id." });
  res.json({ ticket: result.rows[0] });
});

// Hung off the router so the tests can clear a key between cases without
// changing what server.js mounts.
router.submitLimiter = submitLimiter;

module.exports = router;
