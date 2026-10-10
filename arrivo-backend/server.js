require("dotenv").config();

// Refuse to run without a usable JWT_SECRET. Checked before anything else
// loads so a misconfigured deploy fails loudly at boot, not on the first login.
if (!require("./services/jwtSecretCheck").checkJwtSecretAtStartup()) {
  process.exit(1);
}

const express = require("express");
// Patches express.Router so a rejected promise inside any async route
// handler is forwarded to Express's error handling instead of becoming an
// unhandled rejection. Before this, something as simple as GET /api/rides/abc
// (a non-numeric id, which makes the Postgres query throw) would crash the
// entire process — one bad request taking the whole API down for everyone.
// Must be required before any routes/*.js files below, per its own docs.
require("express-async-errors");
const cors = require("cors");

const { ready, pool } = require("./db/db"); // ready resolves once the Postgres schema is initialized
const { secureHeaders } = require("./middleware/secureHeaders");
const { originLock } = require("./middleware/originLock");
const { createHealthRouter } = require("./routes/health");

const authRouter = require("./routes/auth");
const ridesRouter = require("./routes/rides");
const flightsRouter = require("./routes/flights");
const paymentsRouter = require("./routes/payments");
const walletRouter = require("./routes/wallet");
const membershipsRouter = require("./routes/memberships");
const ownersRouter = require("./routes/owners");
const { router: driversRouter } = require("./routes/drivers");
const adminRouter = require("./routes/admin");
const adminExportsRouter = require("./routes/adminExports");
const paymentExceptionsRouter = require("./routes/paymentExceptions");
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
const publicBookingRequestsRouter = require("./routes/publicBookingRequests");
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

// Ops layer. Order matters:
//  1. Do not advertise the framework.
//  2. Baseline security headers on every response (middleware/secureHeaders.js).
//  3. Health endpoints before the origin lock and CORS, so Render's health
//     check and the uptime probes never depend on either (routes/health.js).
//  4. Origin lock, off unless ORIGIN_LOCK_MODE is set (middleware/originLock.js).
app.disable("x-powered-by");
app.use(secureHeaders());
app.use(createHealthRouter({ query: (sql) => pool.query(sql) }));
app.use(originLock());

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
const { csrfOriginCheck } = require("./middleware/sessionCookie");
const { makeOriginCheck, respondIfCorsRejection } = require("./middleware/corsPolicy");

const ALLOWED_ORIGINS = [
  "https://ridearrivo.com",
  "https://www.ridearrivo.com",
  "https://admin.ridearrivo.com",
  // The public self-service booking form (POST /api/public/booking-requests)
  // -- a standalone static page, not part of the main ridearrivo-website
  // deploy, so it needs its own origin here. Rename this if the subdomain
  // ends up called something other than easybook.
  "https://easybook.ridearrivo.com",
  // membership.ridearrivo.com (RideArrivo Membership signup/plan picker)
  // posts to /api/auth/google and /api/auth/apple directly from the
  // browser, same as login.html/signup.html on the main site, so a
  // membership sign-up is a real account on this same backend, not a
  // separate identity silo.
  "https://membership.ridearrivo.com",
  // ArrivoExpress runs standalone on its own subdomain and calls this API
  // straight from the browser.
  "https://express.ridearrivo.com",
];

// Extra origins (for example a Cloudflare Pages preview URL while testing a
// deploy) can be added without a code change: set EXTRA_ALLOWED_ORIGINS to a
// comma-separated list of full origins. Exact match only, no wildcards.
(process.env.EXTRA_ALLOWED_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean)
  .forEach((o) => ALLOWED_ORIGINS.push(o));

app.use(
  cors({
    // Needed so browsers send/accept the shared session cookie on
    // cross-subdomain fetches. Safe because origins are an exact allowlist
    // (a wildcard origin is refused by browsers when credentials are on).
    credentials: true,
    origin: makeOriginCheck(ALLOWED_ORIGINS),
  })
);

// Second CSRF layer for the cookie session (SameSite=Lax is the first).
app.use(csrfOriginCheck(ALLOWED_ORIGINS));

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
// Before the general admin router: exports are admin and operations only,
// and the router applies that itself.
app.use("/api/admin/exports", adminExportsRouter);
app.use("/api/internal/exports", adminExportsRouter.workspaceRouter);
// Before the general admin router, for the same reason as the exports above.
app.use("/api/admin/payment-exceptions", paymentExceptionsRouter);
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
app.use("/api/public", publicBookingRequestsRouter);

// Catches anything express-async-errors forwards (thrown/rejected errors
// from any route above), plus body-parser errors like malformed JSON.
// Must be registered last, after every other app.use()/route. Without this,
// forwarded errors would fall through to Express's default HTML error page
// instead of the JSON error shape every client in this codebase expects.
app.use((err, req, res, next) => {
  if (!res.headersSent && respondIfCorsRejection(err, res)) return;
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
