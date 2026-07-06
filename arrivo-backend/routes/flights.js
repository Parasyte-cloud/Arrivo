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
    const response = await axios.get("http://api.aviationstack.com/v1/flights", {
      params: {
        access_key: process.env.AVIATIONSTACK_KEY,
        flight_iata: flightNumber,
        arr_iata: arrIata,
      },
    });

    const flight = response.data?.data?.[0];
    if (!flight) {
      return res.status(404).json({ error: "No matching flight found for that number/airport/date" });
    }

    // Shape the response into exactly what the app needs — keeps the
    // frontend simple and means you can swap providers later without
    // touching the mobile app at all.
    res.json({
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
    });
  } catch (err) {
    console.error("Flight lookup failed:", err.response?.data || err.message);
    res.status(502).json({ error: "Flight lookup failed. Please try again." });
  }
});

module.exports = router;
