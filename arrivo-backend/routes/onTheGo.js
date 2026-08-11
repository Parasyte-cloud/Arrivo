const express = require("express");
const { pool } = require("../db/db");
const { requireAuth, requireAnyRole } = require("../middleware/auth");
const { isValidPhone, phoneErrorMessage } = require("../services/phone");

const router = express.Router();

const MAX_PASSENGERS = 20;

// POST /api/on-the-go
// body: { pickupAddress, destinationAddress, flightNumber?, passengerCount, contactPhone }
//
// No payment here on purpose. Someone needing a car in the next few hours
// shouldn't be stopped at a checkout screen, so ops confirms a driver first
// and takes payment when they do. That's also why this doesn't go through
// POST /api/rides, which won't create anything unpaid.
router.post("/", requireAuth, async (req, res) => {
  const { pickupAddress, destinationAddress, flightNumber, passengerCount, contactPhone } = req.body;

  const pickup = String(pickupAddress || "").trim();
  const destination = String(destinationAddress || "").trim();
  if (!pickup) return res.status(400).json({ error: "pickupAddress is required" });
  if (!destination) return res.status(400).json({ error: "destinationAddress is required" });

  const passengers = Number(passengerCount);
  if (!Number.isInteger(passengers) || passengers < 1 || passengers > MAX_PASSENGERS) {
    return res.status(400).json({ error: `passengerCount must be a whole number from 1 to ${MAX_PASSENGERS}` });
  }

  // Ops rings this number to confirm, so it has to be dialable.
  if (!contactPhone || !String(contactPhone).trim()) {
    return res.status(400).json({ error: "contactPhone is required" });
  }
  if (!isValidPhone(contactPhone)) {
    return res.status(400).json({ error: phoneErrorMessage("Contact phone number") });
  }

  const result = await pool.query(
    `INSERT INTO on_the_go_requests
       (user_id, pickup_address, destination_address, flight_number, passenger_count, contact_phone)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [
      req.user.id,
      pickup,
      destination,
      flightNumber ? String(flightNumber).trim().toUpperCase() : null,
      passengers,
      String(contactPhone).trim(),
    ]
  );
  res.status(201).json({ request: result.rows[0] });
});

// GET /api/on-the-go/mine — so a rider can see they've actually been heard
// after submitting, rather than the form just vanishing.
router.get("/mine", requireAuth, async (req, res) => {
  const result = await pool.query(
    "SELECT * FROM on_the_go_requests WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20",
    [req.user.id]
  );
  res.json({ requests: result.rows });
});

// GET /api/on-the-go — the ops queue. Pending first, oldest first within that,
// since these are all time-critical and the oldest one has been waiting longest.
// Nothing in the admin dashboard reads this yet, that page still needs building.
router.get("/", requireAuth, requireAnyRole(["admin", "support"]), async (req, res) => {
  const result = await pool.query(
    `SELECT on_the_go_requests.*,
            users.name AS user_name,
            users.email AS user_email
     FROM on_the_go_requests
     JOIN users ON users.id = on_the_go_requests.user_id
     ORDER BY (on_the_go_requests.status = 'pending') DESC, on_the_go_requests.created_at ASC
     LIMIT 200`
  );
  res.json({ requests: result.rows });
});

module.exports = router;
