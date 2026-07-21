require("dotenv").config();
const express = require("express");
// Patches express.Router so a rejected promise inside any async route
// handler is forwarded to Express's error handling instead of becoming an
// unhandled rejection. Before this, something as simple as GET /api/rides/abc
// (a non-numeric id, which makes the Postgres query throw) would crash the
// entire process — one bad request taking the whole API down for everyone.
// Must be required before any routes/*.js files below, per its own docs.
require("express-async-errors");
const cors = require("cors");

const { ready } = require("./db/db"); // resolves once the Postgres schema is initialized

const authRouter = require("./routes/auth");
const ridesRouter = require("./routes/rides");
const flightsRouter = require("./routes/flights");
const paymentsRouter = require("./routes/payments");
const walletRouter = require("./routes/wallet");
const membershipsRouter = require("./routes/memberships");
const ownersRouter = require("./routes/owners");
const { router: driversRouter } = require("./routes/drivers");
const adminRouter = require("./routes/admin");
const waitlistRouter = require("./routes/waitlist");
const placesRouter = require("./routes/places");

const app = express();

app.use(cors());

// The Paystack webhook needs the RAW request body to verify its signature,
// so we skip the JSON parser for that one path and let routes/payments.js
// handle raw parsing itself. Every other route gets normal JSON parsing.
app.use((req, res, next) => {
  if (req.originalUrl === "/api/payments/webhook") return next();
  // Bumped from the 100kb default — profile photos come in as base64 inside
  // the JSON body, which is roughly a third larger than the raw image bytes.
  express.json({ limit: "6mb" })(req, res, next);
});

app.get("/", (req, res) => {
  res.json({ ok: true, service: "arrivo-backend", time: new Date().toISOString() });
});

app.use("/api/auth", authRouter);
app.use("/api/rides", ridesRouter);
app.use("/api/drivers", driversRouter);
app.use("/api/admin", adminRouter);
app.use("/api/waitlist", waitlistRouter);
app.use("/api/flights", flightsRouter);
app.use("/api/payments", paymentsRouter);
app.use("/api/wallet", walletRouter);
app.use("/api/memberships", membershipsRouter);
app.use("/api/owners", ownersRouter);
app.use("/api/places", placesRouter);

// Catches anything express-async-errors forwards (thrown/rejected errors
// from any route above), plus body-parser errors like malformed JSON.
// Must be registered last, after every other app.use()/route. Without this,
// forwarded errors would fall through to Express's default HTML error page
// instead of the JSON error shape every client in this codebase expects.
app.use((err, req, res, next) => {
  console.error(`Unhandled error on ${req.method} ${req.originalUrl}:`, err.message);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: "Something went wrong on our end. Please try again." });
});

const PORT = process.env.PORT || 4000;

ready.then(() => {
  app.listen(PORT, () => {
    console.log(`Arrivo backend running on http://localhost:${PORT}`);
  });
});
