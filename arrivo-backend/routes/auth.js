const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { pool } = require("../db/db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

const SALT_ROUNDS = 10;
const TOKEN_EXPIRY = "7d";

function signToken(user) {
  return jwt.sign({ id: user.id, email: user.email, role: user.role }, process.env.JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
}

function publicUser(user) {
  const { password_hash, ...safe } = user;
  return safe;
}

// POST /api/auth/signup
router.post("/signup", async (req, res) => {
  const { name, email, phone, password, preferredLanguage = "en", role = "rider" } = req.body;

  if (!name || !email || !password) {
    return res.status(400).json({ error: "name, email, and password are required" });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters" });
  }
  if (!["rider", "driver", "owner"].includes(role)) {
    return res.status(400).json({ error: "Invalid role. Admin accounts can't be created via signup — see scripts/create-admin.js" });
  }

  const existing = await pool.query("SELECT id FROM users WHERE email = $1", [email.toLowerCase()]);
  if (existing.rows.length) {
    return res.status(409).json({ error: "An account with that email already exists" });
  }

  const passwordHash = bcrypt.hashSync(password, SALT_ROUNDS);
  const inserted = await pool.query(
    `INSERT INTO users (name, email, phone, password_hash, role, preferred_language)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [name, email.toLowerCase(), phone || null, passwordHash, role, preferredLanguage]
  );

  const user = inserted.rows[0];
  const token = signToken(user);
  res.status(201).json({ token, user: publicUser(user) });
});

// POST /api/auth/login
router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "email and password are required" });
  }

  const result = await pool.query("SELECT * FROM users WHERE email = $1", [email.toLowerCase()]);
  const user = result.rows[0];
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: "Invalid email or password" });
  }

  const token = signToken(user);
  res.json({ token, user: publicUser(user) });
});

// GET /api/auth/me
router.get("/me", requireAuth, async (req, res) => {
  const result = await pool.query("SELECT * FROM users WHERE id = $1", [req.user.id]);
  const user = result.rows[0];
  if (!user) return res.status(404).json({ error: "User not found" });
  res.json({ user: publicUser(user) });
});

// PATCH /api/auth/me
router.patch("/me", requireAuth, async (req, res) => {
  const { name, phone, preferredLanguage } = req.body;
  const current = (await pool.query("SELECT * FROM users WHERE id = $1", [req.user.id])).rows[0];
  if (!current) return res.status(404).json({ error: "User not found" });

  const updated = await pool.query(
    `UPDATE users SET name = $1, phone = $2, preferred_language = $3 WHERE id = $4 RETURNING *`,
    [name ?? current.name, phone ?? current.phone, preferredLanguage ?? current.preferred_language, req.user.id]
  );

  res.json({ user: publicUser(updated.rows[0]) });
});

// POST /api/auth/guest — guest checkout for the website booking flow.
// New email -> silently create a real rider account (random password the
// guest never sees) and log them in. Existing email -> refuse; otherwise
// anyone could "book as" an existing rider with no password check at all.
router.post("/guest", async (req, res) => {
  const { name, email, phone, preferredLanguage = "en" } = req.body;

  if (!name || !email) {
    return res.status(400).json({ error: "name and email are required" });
  }

  const existing = await pool.query("SELECT id FROM users WHERE email = $1", [email.toLowerCase()]);
  if (existing.rows.length) {
    return res.status(409).json({
      error: "An account already exists with this email. Please log in with your password to continue.",
      requiresLogin: true,
    });
  }

  const randomPassword = crypto.randomBytes(24).toString("hex");
  const passwordHash = bcrypt.hashSync(randomPassword, SALT_ROUNDS);

  const inserted = await pool.query(
    `INSERT INTO users (name, email, phone, password_hash, role, preferred_language)
     VALUES ($1, $2, $3, $4, 'rider', $5) RETURNING *`,
    [name, email.toLowerCase(), phone || null, passwordHash, preferredLanguage]
  );

  const user = inserted.rows[0];
  const token = signToken(user);
  res.status(201).json({ token, user: publicUser(user) });
});

module.exports = router;
