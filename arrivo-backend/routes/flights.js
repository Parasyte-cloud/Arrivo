const express = require("express");
const axios = require("axios");
const { requireAuth } = require("../middleware/auth");
const { createLimiter } = require("../services/smallLimiter");
const router = express.Router();

// Common Nigerian airport IATA codes, so the app can send a friendly name
// instead of remembering codes.
const NIGERIA_AIRPORTS = {
  LOS: "Lagos (Murtala Muhammed)",
  ABV: "Abuja (Nnamdi Azikiwe)",
  PHC: "Port Harcourt",
  KAN: "Kano (Mallam Aminu Kano)",
  ENU: "Enugu (Akanu Ibiam)",
  CBQ: "Calabar (Margaret Ekpo)",
  BNI: "Benin",
  KAD: "Kaduna",
};

// Shared lookup used by both the GET /status route below (rider-facing,
// on-demand refresh) and services/scheduler.js (background reminder +
// flight-issue sweep, no HTTP request/response involved) — kept in one
// place so both callers get the exact same shape and the exact same
// "not configured" / "not found" handling instead of two copies drifting
// apart over time. Returns null (never throws for the "not configured" or
// "not found" cases) so the scheduler can just skip a ride it can't check
// this pass rather than needing its own try/catch around every call site.
async function lookupFlightStatus(flightNumber, arrIata = "LOS", opts = {}) {
  if (!flightNumber) return null;
  if (!process.env.AVIATIONSTACK_KEY || process.env.AVIATIONSTACK_KEY === "replace_me") return null;

  // Normalized here too, not just in the two callers (website booking.js /
  // app HomeScreen.js already trim+uppercase before sending) — this is the
  // single choke point every lookup goes through (including the
  // scheduler's background jobs, which never pass through client code at
  // all), so it's the right place to guarantee it rather than trusting
  // every caller to have done it.
  const normalizedFlightNumber = String(flightNumber).trim().toUpperCase();
  if (!normalizedFlightNumber) return null;

  // HTTPS, not HTTP — aviationstack's free plan has included HTTPS for a
  // while now, so there's no remaining reason to send the access_key in
  // the query string of a plaintext request.
  const response = await axios.get("https://api.aviationstack.com/v1/flights", {
    params: {
      access_key: process.env.AVIATIONSTACK_KEY,
      flight_iata: normalizedFlightNumber,
      ...(opts.depIata ? { dep_iata: opts.depIata } : { arr_iata: arrIata }),
      // flight_date is a paid-plan parameter on AviationStack; on the free plan sending it is an
      // error, so it is only sent when AVIATIONSTACK_HISTORICAL=true says the plan allows it.
      ...(opts.date && process.env.AVIATIONSTACK_HISTORICAL === "true" ? { flight_date: opts.date } : {}),
    },
  });

  // aviationstack answers a bad/expired key, an exhausted monthly quota, or
  // a plan-restricted parameter with HTTP 200 and an `error` object in the
  // body — not an HTTP error status. Treating that the same as "zero
  // results" (the previous behavior: `response.data?.data?.[0]` is simply
  // undefined either way) silently disguised a real account/config problem
  // as if the rider had mistyped a valid flight number. Throw instead, so
  // it surfaces as a 502 to the rider and an actual error line in logs —
  // both existing callers of this function (the /status route below, and
  // services/scheduler.js's two background sweeps) already wrap this call
  // in try/catch and log err.message, so this is a strictly more useful
  // failure than the silent null was, not a new crash risk.
  if (response.data?.error) {
    const err = new Error(
      response.data.error.message || response.data.error.info || response.data.error.type || "aviationstack API error"
    );
    err.aviationstack = response.data.error;
    throw err;
  }

  const flight = response.data?.data?.[0];
  if (!flight) return null;

  // Shape the response into exactly what callers need — keeps both the
  // frontend and the scheduler simple, and means you can swap providers
  // later without touching either.
  return {
    flightNumber: flight.flight?.iata,
    airline: flight.airline?.name,
    status: flight.flight_status, // scheduled | active | landed | cancelled | incident | diverted
    departure: {
      airport: flight.departure?.airport,
      scheduled: flight.departure?.scheduled,
    },
    arrival: {
      airport: flight.arrival?.airport || NIGERIA_AIRPORTS[arrIata] || arrIata,
      scheduled: flight.arrival?.scheduled,
      estimated: flight.arrival?.estimated,
      terminal: flight.arrival?.terminal,
      gate: flight.arrival?.gate,
    },
  };
}

// GET /api/flights/status?flightNumber=BA075&arrIata=LOS
// requireAuth added — this was previously open to anyone, letting an
// unauthenticated caller burn the paid AviationStack quota with no rate
// limiting. The rider app now sends its token (see services/api.js
// getFlightStatus); the scheduler's own background lookups call
// lookupFlightStatus directly and never go through this HTTP route at all,
// so they're unaffected.
// Lookups spend a paid provider quota, so one account cannot ask without limit.
const allowLookup = createLimiter({ max: 30, windowMs: 10 * 60 * 1000 });

router.get("/status", requireAuth, async (req, res) => {
  if (!allowLookup(String(req.user.id))) {
    return res.status(429).json({ error: "You have checked a lot of flights. Please wait a few minutes and try again." });
  }
  const { flightNumber, arrIata = "LOS", date } = req.query;
  const input = require("../services/flightInput");
  const { lookupFlight } = require("../services/flightLookup");
  const { MESSAGES } = require("../services/flightBooking");

  if (!flightNumber) {
    return res.status(400).json({ error: "flightNumber is required" });
  }
  // A booking code is not a flight number and no status service can look one up, so say so
  // instead of reporting "not found" as if the rider had mistyped a real flight.
  const parsed = input.normalizeFlightNumber(flightNumber);
  if (!parsed.ok) {
    return res.status(400).json({ error: MESSAGES[parsed.reason] || MESSAGES.format, code: `flight_${parsed.reason}` });
  }
  let day = null;
  if (date) {
    const d = input.normalizeFlightDate(date);
    if (!d.ok) return res.status(400).json({ error: "Enter the flight date as year-month-day, today or later.", code: `flight_date_${d.reason}` });
    day = d.date;
  }

  const looked = await lookupFlight({ flightNumber, date: day, airport: String(arrIata).toUpperCase().slice(0, 3) });
  if (looked.reason === "no_provider") {
    return res.status(503).json({ error: "Flight tracking is not switched on yet.", tracking: { state: looked.state, reason: looked.reason } });
  }
  if (looked.reason === "provider_error") {
    return res.status(502).json({ error: "Flight lookup is temporarily unavailable. Please try again shortly.", tracking: { state: looked.state, reason: looked.reason } });
  }
  if (!looked.flight) {
    // A flight that has not started boarding is often not in provider data yet, and one more than
    // two days out cannot be tracked yet. That is a normal answer, not a sign of a typo, and it
    // never blocks the booking.
    return res.status(404).json({
      error: looked.state === "not_yet"
        ? "That flight is too far ahead to track yet. We will start checking about two days before it lands, and your booking is not affected."
        : "We couldn't pull live status for that flight yet. If the number and date are right, this is normal for a flight that hasn't started boarding. We'll keep checking as your trip gets closer, and your booking isn't affected.",
      tracking: { state: looked.state, label: looked.label, reason: looked.reason },
    });
  }
  const { track, origin, ...forRider } = looked.flight;
  res.json({ ...forRider, tracking: { state: looked.state, label: looked.label, reason: looked.reason, delayMin: looked.delayMin ?? null } });
});

module.exports = router;
module.exports.lookupFlightStatus = lookupFlightStatus;
