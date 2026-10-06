const express = require("express");
const axios = require("axios");
const { requireAuth } = require("../middleware/auth");
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
async function lookupFlightStatus(flightNumber, arrIata = "LOS") {
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
  // Explicit timeout so a slow/unreachable aviationstack call can't hang
  // this request indefinitely -- same reasoning as services/email.js's and
  // services/whatsapp.js's outbound calls.
  const response = await axios.get("https://api.aviationstack.com/v1/flights", {
    params: {
      access_key: process.env.AVIATIONSTACK_KEY,
      flight_iata: normalizedFlightNumber,
      arr_iata: arrIata,
    },
    timeout: 10000,
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
router.get("/status", requireAuth, async (req, res) => {
  const { flightNumber, arrIata = "LOS" } = req.query;

  if (!flightNumber) {
    return res.status(400).json({ error: "flightNumber is required" });
  }
  if (!process.env.AVIATIONSTACK_KEY || process.env.AVIATIONSTACK_KEY === "replace_me") {
    return res.status(500).json({ error: "AVIATIONSTACK_KEY is not configured on the server" });
  }

  try {
    const result = await lookupFlightStatus(flightNumber, arrIata);
    if (!result) {
      // aviationstack's free plan only carries REAL-TIME flights — a
      // flight that hasn't started boarding yet (the common case: riders
      // usually track a flight while booking a pickup days or hours
      // ahead) genuinely won't be in its data yet, and that's the normal
      // outcome here, not a sign the rider mistyped anything. The old copy
      // ("No matching flight found... double-check the number") pointed
      // the blame at the rider even when the number was perfectly correct
      // — this doesn't block booking either way (see book.html/
      // booking.js's flightContinue handler and RouteScreen.js, neither of
      // which requires a successful Track before proceeding), so say so.
      return res.status(404).json({
        error: "We couldn't pull live status for that flight yet. If the number's right, this is normal for a flight that hasn't started boarding. We'll keep checking as your trip gets closer, and your booking isn't affected.",
      });
    }
    res.json(result);
  } catch (err) {
    console.error("Flight lookup failed:", err.aviationstack || err.response?.data || err.message);
    res.status(502).json({ error: "Flight lookup is temporarily unavailable. Please try again shortly." });
  }
});

module.exports = router;
module.exports.lookupFlightStatus = lookupFlightStatus;
