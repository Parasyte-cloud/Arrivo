const express = require("express");
const { pool } = require("../db/db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

// A rider saves one or more contacts here once, instead of retyping a name
// and phone number from scratch on every single booking (see
// rides.emergency_contact_name/phone, still set per-ride on RouteScreen —
// that field now pre-fills from the first contact here, but stays editable
// per trip). Every route below scopes strictly to req.user.id, so a rider
// can only ever see, add, or remove their own contacts.

// GET /api/emergency-contacts
router.get("/", requireAuth, async (req, res) => {
  const result = await pool.query(
    "SELECT * FROM emergency_contacts WHERE user_id = $1 ORDER BY created_at ASC",
    [req.user.id]
  );
  res.json({ contacts: result.rows });
});

// POST /api/emergency-contacts
// body: { name, phone, relationship? }
router.post("/", requireAuth, async (req, res) => {
  const { name, phone, relationship } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: "name is required" });
  if (!phone || !phone.trim()) return res.status(400).json({ error: "phone is required" });

  const result = await pool.query(
    `INSERT INTO emergency_contacts (user_id, name, phone, relationship)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [req.user.id, name.trim(), phone.trim(), relationship ? relationship.trim() : null]
  );
  res.status(201).json({ contact: result.rows[0] });
});

// DELETE /api/emergency-contacts/:id
router.delete("/:id", requireAuth, async (req, res) => {
  const result = await pool.query(
    "DELETE FROM emergency_contacts WHERE id = $1 AND user_id = $2 RETURNING id",
    [req.params.id, req.user.id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: "Contact not found" });
  res.json({ ok: true });
});

module.exports = router;
