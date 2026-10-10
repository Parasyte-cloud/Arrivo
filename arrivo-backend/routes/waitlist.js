const express = require("express");
const rateLimit = require("express-rate-limit");
const { pool } = require("../db/db");

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Public and unauthenticated, so without a cap anyone could fill the table.
// Shared carrier addresses are common, hence a generous per-IP allowance.
const waitlistLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: Number(process.env.WAITLIST_RATE_LIMIT) || 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: (req, res) => res.status(429).json({ error: "Too many sign-ups from this network. Please try again later." }),
});

router.post("/", waitlistLimiter, async (req, res) => {
  const { email, source } = req.body || {};

  if (typeof email !== "string" || email.length > 254 || !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: "Please enter a valid email address." });
  }

  const normalized = email.trim().toLowerCase();

  try {
    await pool.query("INSERT INTO waitlist (email, source) VALUES ($1, $2)", [normalized, typeof source === "string" && source.trim() ? source.trim().slice(0, 64) : "website"]);
    return res.status(201).json({ message: "You're on the list!" });
  } catch (err) {
    if (err.code === "23505") {
      // unique_violation — already signed up. Treat as success from the
      // visitor's point of view, no need for them to know or care.
      return res.status(200).json({ message: "You're already on the list!" });
    }
    console.error("Waitlist insert failed:", err.message);
    return res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

router.get("/count", async (req, res) => {
  const result = await pool.query("SELECT COUNT(*) as n FROM waitlist");
  res.json({ count: Number(result.rows[0].n) });
});

module.exports = router;
