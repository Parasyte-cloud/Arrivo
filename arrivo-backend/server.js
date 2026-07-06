require("dotenv").config();
const express = require("express");
const cors = require("cors");

require("./db/db"); // initializes the SQLite database and schema on startup

const authRouter = require("./routes/auth");
const ridesRouter = require("./routes/rides");
const flightsRouter = require("./routes/flights");
const paymentsRouter = require("./routes/payments");
const { router: driversRouter } = require("./routes/drivers");
const adminRouter = require("./routes/admin");

const app = express();

app.use(cors());

// The Paystack webhook needs the RAW request body to verify its signature,
// so we skip the JSON parser for that one path and let routes/payments.js
// handle raw parsing itself. Every other route gets normal JSON parsing.
app.use((req, res, next) => {
  if (req.originalUrl === "/api/payments/webhook") return next();
  express.json()(req, res, next);
});

app.get("/", (req, res) => {
  res.json({ ok: true, service: "arrivo-backend", time: new Date().toISOString() });
});

app.use("/api/auth", authRouter);
app.use("/api/rides", ridesRouter);
app.use("/api/drivers", driversRouter);
app.use("/api/admin", adminRouter);
app.use("/api/flights", flightsRouter);
app.use("/api/payments", paymentsRouter);

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Arrivo backend running on http://localhost:${PORT}`);
});
