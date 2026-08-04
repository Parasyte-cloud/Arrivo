const express = require("express");
const { pool } = require("../db/db");
const { requireAuth, requireAnyRole } = require("../middleware/auth");

const router = express.Router();

const TYPES = ["complaint", "inquiry", "support"];
const MAX_SUBJECT = 140;
const MAX_DESCRIPTION = 4000;

// POST /api/support/tickets
// body: { type, subject, description, rideId? }
router.post("/tickets", requireAuth, async (req, res) => {
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
    if (!Number.isInteger(Number(rideId))) {
      return res.status(400).json({ error: "rideId must be a whole number" });
    }
    const owned = await pool.query("SELECT id FROM rides WHERE id = $1 AND rider_id = $2", [
      Number(rideId),
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

// GET /api/support/tickets — ops only, newest first.
// Nothing in the admin dashboard reads this yet. It's here so tickets aren't
// write-only until that page gets built.
router.get("/tickets", requireAuth, requireAnyRole(["admin", "support"]), async (req, res) => {
  const result = await pool.query(
    `SELECT support_tickets.*,
            users.name AS user_name,
            users.email AS user_email,
            users.phone AS user_phone
     FROM support_tickets
     JOIN users ON users.id = support_tickets.user_id
     ORDER BY support_tickets.created_at DESC
     LIMIT 200`
  );
  res.json({ tickets: result.rows });
});

module.exports = router;
