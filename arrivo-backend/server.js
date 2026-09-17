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
const emergencyContactsRouter = require("./routes/emergencyContacts");
const callsRouter = require("./routes/calls");
const chatRouter = require("./routes/chat");
const onTheGoRouter = require("./routes/onTheGo");
const instantRidesRouter = require("./routes/instantRides");
const alertsRouter = require("./routes/alerts");
const eventsRouter = require("./routes/events-sse");
const liveMapRouter = require("./routes/live-map");
const supportRouter = require("./routes/support");
const familyRouter = require("./routes/family");
const partnerVenuesRouter = require("./routes/partnerVenues");
const { startScheduler } = require("./services/scheduler");

const app = express();

// Render (and most PaaS hosts) sit behind a reverse proxy — requests reach
// this process over plain HTTP internally, with the original scheme only
// preserved in the X-Forwarded-Proto header. Without trusting that proxy,
// req.protocol always reports "http" even for a real https:// request from
// a rider's phone, which would make the verification-email link built from
// req.protocol below (routes/auth.js) silently downgrade to http://. Only
// the first hop is trusted (Render's own edge), not an arbitrary chain.
app.set("trust proxy", 1);

// Locked down 2026-09-17 (security audit follow-up): previously cors() with
// no options, which reflects any Origin and allows credentials-less
// cross-origin reads of every API response given a leaked Bearer token --
// low severity since auth here is Bearer-token, not cookie-based (so no
// classic CSRF), but there is no reason to leave every arbitrary origin
// able to read this API's responses in a browser. Real allowlist below:
// ridearrivo.com (+www) is the rider-facing website, admin.ridearrivo.com
// is the internal ops dashboard (confirmed via the live Vercel project,
// 2026-09-17). Requests with NO Origin header (native mobile apps via
// fetch/axios, curl, server-to-server calls, Postman) are allowed through
// unconditionally -- CORS is a browser-only enforcement mechanism, the
// rider/driver apps never send a browser-style Origin header, so this
// allowlist cannot break them regardless of how strict it is.
const ALLOWED_ORIGINS = [
  "https://ridearrivo.com",
  "https://www.ridearrivo.com",
  "https://admin.ridearrivo.com",
];

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || ALLOWED_ORIGINS.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error("Not allowed by CORS"));
    },
  })
);

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
app.use("/api/emergency-contacts", emergencyContactsRouter);
app.use("/api/calls", callsRouter);
app.use("/api/chat", chatRouter);
app.use("/api/on-the-go", onTheGoRouter);
app.use("/api/instant-rides", instantRidesRouter);
app.use("/api/alerts", alertsRouter);
app.use("/api/events", eventsRouter);
app.use("/api/live-map", liveMapRouter);
app.use("/api/support", supportRouter);
app.use("/api/family", familyRouter);
app.use("/api/partner-venues", partnerVenuesRouter);

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
  // Reminders (5h/3h/1h/now before pickup), flight cancellation/reschedule
  // detection, and preferred-driver claim-window expiry — see
  // services/scheduler.js. Started once, after the schema is ready, same
  // as the HTTP listener above.
  startScheduler();
});
