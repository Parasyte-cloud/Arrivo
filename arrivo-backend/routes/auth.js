const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { pool } = require("../db/db");
const { requireAuth } = require("../middleware/auth");
const { sendPasswordResetEmail, sendWelcomeEmail, sendVerificationEmail } = require("../services/email");
const { validateImageDataUrl } = require("../services/imageValidation");

const router = express.Router();

const SALT_ROUNDS = 10;
const TOKEN_EXPIRY = "7d";

function signToken(user) {
  return jwt.sign({ id: user.id, email: user.email, role: user.role }, process.env.JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
}

// Registration photos arrive as a base64 data URL from the browser/app
// (avoids needing separate multipart upload handling and cloud storage for
// now). Kept intentionally simple: valid image type, and a real size cap so
// nobody can wedge a multi-megabyte file into the database by mistake.
const MAX_AVATAR_BYTES = 4 * 1024 * 1024; // 4MB

function validateAvatarDataUrl(dataUrl) {
  return validateImageDataUrl(dataUrl, "Profile photo", MAX_AVATAR_BYTES);
}

function publicUser(user) {
  const { password_hash, email_verification_token, email_verification_expires, reset_token, reset_token_expires, ...safe } = user;
  return safe;
}

// POST /api/auth/signup — full profile creation.
// body: { firstName, lastName, email, passportNumber?, phone, password,
//         confirmPassword, agreedToTerms, preferredLanguage?, role? }
// This is the real account/profile flow (as opposed to /guest, which is
// the lightweight no-password path used by the website's booking checkout).
router.post("/signup", async (req, res) => {
  const {
    firstName, lastName, email, passportNumber, phone,
    password, confirmPassword, agreedToTerms, avatarDataUrl,
    whatsappNumber, countryOfResidence, dateOfBirth,
    preferredLanguage = "en", role = "rider",
  } = req.body;

  if (!firstName || !lastName || !email || !password) {
    return res.status(400).json({ error: "firstName, lastName, email, and password are required" });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters" });
  }
  if (confirmPassword !== undefined && password !== confirmPassword) {
    return res.status(400).json({ error: "Passwords do not match" });
  }
  if (!agreedToTerms) {
    return res.status(400).json({ error: "You must agree to the data protection and privacy terms to create a profile" });
  }
  if (!["rider", "driver", "owner"].includes(role)) {
    return res.status(400).json({ error: "Invalid role. Admin accounts can't be created via signup — see scripts/create-admin.js" });
  }
  const avatarError = validateAvatarDataUrl(avatarDataUrl);
  if (avatarError) return res.status(400).json({ error: avatarError });

  const existing = await pool.query("SELECT id FROM users WHERE email = $1", [email.toLowerCase()]);
  if (existing.rows.length) {
    return res.status(409).json({ error: "An account with that email already exists" });
  }

  const name = `${firstName} ${lastName}`.trim();
  const passwordHash = bcrypt.hashSync(password, SALT_ROUNDS);
  const verificationToken = crypto.randomBytes(32).toString("hex");
  const verificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

  const inserted = await pool.query(
    `INSERT INTO users (name, email, phone, passport_number, password_hash, role, preferred_language,
                         agreed_to_terms, email_verification_token, email_verification_expires, avatar_url,
                         whatsapp_number, country_of_residence, date_of_birth)
     VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8, $9, $10, $11, $12, $13) RETURNING *`,
    [name, email.toLowerCase(), phone || null, passportNumber || null, passwordHash, role, preferredLanguage, verificationToken, verificationExpires, avatarDataUrl || null, whatsappNumber || null, countryOfResidence || null, dateOfBirth || null]
  );

  const user = inserted.rows[0];
  const token = signToken(user);

  const verifyUrl = `${process.env.EMAIL_VERIFY_BASE_URL || "https://ridearrivo.com/verify-email.html"}?token=${verificationToken}`;
  sendVerificationEmail(user.email, verifyUrl).catch((e) => console.error("Verification email failed:", e.message));
  sendWelcomeEmail(user.email, user.name).catch((e) => console.error("Welcome email failed:", e.message));

  res.status(201).json({ token, user: publicUser(user) });
});

// POST /api/auth/verify-email
// body: { token }
router.post("/verify-email", async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: "token is required" });

  const result = await pool.query(
    "SELECT * FROM users WHERE email_verification_token = $1 AND email_verification_expires > now()",
    [token]
  );
  const user = result.rows[0];
  if (!user) return res.status(400).json({ error: "This verification link is invalid or has expired." });

  await pool.query(
    "UPDATE users SET email_verified = true, email_verification_token = NULL, email_verification_expires = NULL WHERE id = $1",
    [user.id]
  );

  res.json({ message: "Email verified. Thanks for confirming your account." });
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
  const { name, phone, preferredLanguage, whatsappNumber, countryOfResidence, passportNumber, avatarDataUrl } = req.body;
  const current = (await pool.query("SELECT * FROM users WHERE id = $1", [req.user.id])).rows[0];
  if (!current) return res.status(404).json({ error: "User not found" });

  if (avatarDataUrl !== undefined) {
    const avatarError = validateAvatarDataUrl(avatarDataUrl);
    if (avatarError) return res.status(400).json({ error: avatarError });
  }

  const updated = await pool.query(
    `UPDATE users SET name = $1, phone = $2, preferred_language = $3,
                       whatsapp_number = $4, country_of_residence = $5, passport_number = $6,
                       avatar_url = $7
     WHERE id = $8 RETURNING *`,
    [
      name ?? current.name,
      phone ?? current.phone,
      preferredLanguage ?? current.preferred_language,
      whatsappNumber ?? current.whatsapp_number,
      countryOfResidence ?? current.country_of_residence,
      passportNumber ?? current.passport_number,
      avatarDataUrl !== undefined ? avatarDataUrl : current.avatar_url,
      req.user.id,
    ]
  );

  res.json({ user: publicUser(updated.rows[0]) });
});

// POST /api/auth/guest — lightweight checkout for the website's booking flow.
// body: { name, email, phone, whatsappNumber?, countryOfResidence?, agreedToTerms, preferredLanguage? }
// New email -> silently create a real rider account (random password the
// guest never sees) and log them in. Existing email -> refuse; otherwise
// anyone could "book as" an existing rider with no password check at all.
router.post("/guest", async (req, res) => {
  const { name, email, phone, whatsappNumber, countryOfResidence, agreedToTerms, preferredLanguage = "en" } = req.body;

  if (!name || !email) {
    return res.status(400).json({ error: "name and email are required" });
  }
  if (!agreedToTerms) {
    return res.status(400).json({ error: "You must agree to the terms to continue" });
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
    `INSERT INTO users (name, email, phone, whatsapp_number, country_of_residence, password_hash, role, preferred_language, agreed_to_terms)
     VALUES ($1, $2, $3, $4, $5, $6, 'rider', $7, true) RETURNING *`,
    [name, email.toLowerCase(), phone || null, whatsappNumber || null, countryOfResidence || null, passwordHash, preferredLanguage]
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
