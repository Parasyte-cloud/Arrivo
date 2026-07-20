require("dotenv").config();
const express = require("express");
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

const PORT = process.env.PORT || 4000;

ready.then(() => {
  app.listen(PORT, () => {
    console.log(`Arrivo backend running on http://localhost:${PORT}`);
  });
});
