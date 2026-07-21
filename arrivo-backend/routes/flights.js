const express = require("express");
const axios = require("axios");
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

  const response = await axios.get("http://api.aviationstack.com/v1/flights", {
    params: {
      access_key: process.env.AVIATIONSTACK_KEY,
      flight_iata: flightNumber,
      arr_iata: arrIata,
    },
  });

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
router.get("/status", async (req, res) => {
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
      return res.status(404).json({ error: "No matching flight found for that number/airport/date" });
    }
    res.json(result);
  } catch (err) {
    console.error("Flight lookup failed:", err.response?.data || err.message);
    res.status(502).json({ error: "Flight lookup failed. Please try again." });
  }
});

module.exports = router;
module.exports.lookupFlightStatus = lookupFlightStatus;
