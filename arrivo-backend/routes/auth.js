const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const db = require("../db/db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

const SALT_ROUNDS = 10;
const TOKEN_EXPIRY = "7d";

function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: TOKEN_EXPIRY }
  );
}

function publicUser(user) {
  const { password_hash, ...safe } = user;
  return safe;
}

// POST /api/auth/signup
// body: { name, email, phone, password, preferredLanguage?, role? }
router.post("/signup", (req, res) => {
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

  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email.toLowerCase());
  if (existing) {
    return res.status(409).json({ error: "An account with that email already exists" });
  }

  const passwordHash = bcrypt.hashSync(password, SALT_ROUNDS);

  const result = db
    .prepare(
      `INSERT INTO users (name, email, phone, password_hash, role, preferred_language)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(name, email.toLowerCase(), phone || null, passwordHash, role, preferredLanguage);

  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(result.lastInsertRowid);
  const token = signToken(user);

  res.status(201).json({ token, user: publicUser(user) });
});

// POST /api/auth/login
// body: { email, password }
router.post("/login", (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "email and password are required" });
  }

  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email.toLowerCase());
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    // Same error for "no such user" and "wrong password" — don't reveal which one it was.
    return res.status(401).json({ error: "Invalid email or password" });
  }

  const token = signToken(user);
  res.json({ token, user: publicUser(user) });
});

// GET /api/auth/me — requires a valid token, returns the current user
router.get("/me", requireAuth, (req, res) => {
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
  if (!user) return res.status(404).json({ error: "User not found" });
  res.json({ user: publicUser(user) });
});

// PATCH /api/auth/me — update preferred language, name, phone
router.patch("/me", requireAuth, (req, res) => {
  const { name, phone, preferredLanguage } = req.body;
  const current = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
  if (!current) return res.status(404).json({ error: "User not found" });

  db.prepare(
    `UPDATE users SET name = ?, phone = ?, preferred_language = ? WHERE id = ?`
  ).run(
    name ?? current.name,
    phone ?? current.phone,
    preferredLanguage ?? current.preferred_language,
    req.user.id
  );

  const updated = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
  res.json({ user: publicUser(updated) });
});

module.exports = router;
