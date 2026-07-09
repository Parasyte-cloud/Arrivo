const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { pool } = require("../db/db");
const { requireAuth } = require("../middleware/auth");
const { sendPasswordResetEmail, sendWelcomeEmail } = require("../services/email");

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
  sendWelcomeEmail(user.email, user.name).catch((e) => console.error("Welcome email failed:", e.message));
  res.status(201).json({ token, user: publicUser(user) });
});

// POST /api/auth/forgot-password
// body: { email }
// Always responds the same way whether or not the email exists — otherwise
// this endpoint becomes a way to check which emails have accounts.
router.post("/forgot-password", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "email is required" });

  const genericResponse = { message: "If an account exists for that email, a reset link has been sent." };

  const result = await pool.query("SELECT * FROM users WHERE email = $1", [email.toLowerCase()]);
  const user = result.rows[0];
  if (!user) return res.json(genericResponse); // don't reveal whether the email exists

  const resetToken = crypto.randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

  await pool.query("UPDATE users SET reset_token = $1, reset_token_expires = $2 WHERE id = $3", [
    resetToken, expires, user.id,
  ]);

  const resetUrl = `${process.env.PASSWORD_RESET_BASE_URL || "https://ridearrivo.com/reset-password.html"}?token=${resetToken}`;
  sendPasswordResetEmail(user.email, resetUrl).catch((e) => console.error("Reset email failed:", e.message));

  res.json(genericResponse);
});

// POST /api/auth/reset-password
// body: { token, newPassword }
router.post("/reset-password", async (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword) return res.status(400).json({ error: "token and newPassword are required" });
  if (newPassword.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });

  const result = await pool.query(
    "SELECT * FROM users WHERE reset_token = $1 AND reset_token_expires > now()",
    [token]
  );
  const user = result.rows[0];
  if (!user) return res.status(400).json({ error: "This reset link is invalid or has expired. Please request a new one." });

  const passwordHash = bcrypt.hashSync(newPassword, SALT_ROUNDS);
  await pool.query(
    "UPDATE users SET password_hash = $1, reset_token = NULL, reset_token_expires = NULL WHERE id = $2",
    [passwordHash, user.id]
  );

  res.json({ message: "Password updated. You can now log in with your new password." });
});

module.exports = router;
