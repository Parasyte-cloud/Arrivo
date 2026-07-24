const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { placesAutocomplete, placeDetails, reverseGeocode } = require("../services/googleMaps");

const router = express.Router();

// GET /api/places/autocomplete?input=...&sessionToken=...
// requireAuth mainly to keep this proxy from being an open, anonymous way
// for anyone on the internet to spend our Google Maps budget — not because
// address suggestions are sensitive.
router.get("/autocomplete", requireAuth, async (req, res) => {
  const { input, sessionToken } = req.query;
  if (!input || !input.trim()) {
    return res.json({ predictions: [] });
  }
  try {
    const predictions = await placesAutocomplete(input, sessionToken);
    res.json({ predictions });
  } catch (err) {
    console.error("Places autocomplete failed:", err.message);
    res.status(502).json({ error: "Couldn't fetch address suggestions right now." });
  }
});

// GET /api/places/details?placeId=...&sessionToken=...
router.get("/details", requireAuth, async (req, res) => {
  const { placeId, sessionToken } = req.query;
  if (!placeId) return res.status(400).json({ error: "placeId is required" });
  try {
    const details = await placeDetails(placeId, sessionToken);
    res.json(details);
  } catch (err) {
    console.error("Place details failed:", err.message);
    res.status(502).json({ error: "Couldn't look up that address right now." });
  }
});

// GET /api/places/reverse-geocode?lat=...&lng=...
// Used by the rider app's "use my current location" pickup button — turns
// the device's raw GPS coordinate into an address string to show/store,
// same as picking a suggestion from autocomplete would.
router.get("/reverse-geocode", requireAuth, async (req, res) => {
  const { lat, lng } = req.query;
  if (lat == null || lng == null) return res.status(400).json({ error: "lat and lng are required" });
  try {
    const result = await reverseGeocode(Number(lat), Number(lng));
    res.json(result);
  } catch (err) {
    console.error("Reverse geocode failed:", err.message);
    res.status(502).json({ error: "Couldn't look up an address for that location right now." });
  }
});

module.exports = router;
