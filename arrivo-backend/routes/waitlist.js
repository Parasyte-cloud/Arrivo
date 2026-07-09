const express = require("express");
const { pool } = require("../db/db");

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.post("/", async (req, res) => {
  const { email, source } = req.body;

  if (!email || !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: "Please enter a valid email address." });
  }

  const normalized = email.trim().toLowerCase();

  try {
    await pool.query("INSERT INTO waitlist (email, source) VALUES ($1, $2)", [normalized, source || "website"]);
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
