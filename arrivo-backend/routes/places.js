const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { placesAutocomplete, placeDetails, reverseGeocode, computeRoute } = require("../services/googleMaps");

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

// GET /api/places/route?fromLat=&fromLng=&toLat=&toLng=
// The road a car will take between two points, for the live map. 204 when
// Google has no route, so the app quietly draws a straight line instead.
router.get("/route", requireAuth, async (req, res) => {
  const nums = ["fromLat", "fromLng", "toLat", "toLng"].map((k) => (req.query[k] === undefined || req.query[k] === "" ? NaN : Number(req.query[k])));
  const [fromLat, fromLng, toLat, toLng] = nums;
  const bad = nums.some((n) => !Number.isFinite(n))
    || Math.abs(fromLat) > 90 || Math.abs(toLat) > 90 || Math.abs(fromLng) > 180 || Math.abs(toLng) > 180;
  if (bad) return res.status(400).json({ error: "fromLat, fromLng, toLat and toLng must be valid coordinates" });
  try {
    const route = await computeRoute({ lat: fromLat, lng: fromLng }, { lat: toLat, lng: toLng });
    if (!route) return res.status(204).end();
    res.json(route);
  } catch (err) {
    console.error("Route lookup failed:", err.message);
    res.status(502).json({ error: "Couldn't work out the route right now." });
  }
});

module.exports = router;
