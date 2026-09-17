// Arrivo Express Phase 3 — Grotto x RideArrivo. Public-ish (any signed-in
// rider) read access to the active partner-venue list, so the booking
// screen can offer "reserve a pickup from..." as a picker. Admin
// create/edit/deactivate lives in routes/admin.js instead — this file is
// deliberately just the rider-facing read path, same split as
// routes/family.js (rider actions) vs the admin config endpoints in
// routes/admin.js.
const express = require("express");
const { pool } = require("../db/db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

// GET /api/partner-venues — active venues only, ordered by name. lat/lng
// are included so the app can drop a pin/pre-fill the map, but nothing
// here reveals anything an unassigned rider shouldn't see (no internal
// admin_notes-equivalent field exists on this table by design).
router.get("/", requireAuth, async (req, res) => {
  const result = await pool.query(
    `SELECT id, name, category, address, lat, lng, perk_description
     FROM partner_venues WHERE is_active = true ORDER BY name ASC`
  );
  res.json({ venues: result.rows });
});

module.exports = router;
