const express = require("express");
const { buildBookingConfig } = require("../services/bookingConfig");

const router = express.Router();

// GET /api/config/booking
// Public and read-only: nothing here is private (the support number is on the
// website). It has to work before login so an app can learn the rules, and
// without a version check so an out-of-date app can still read the update link.
router.get("/booking", (req, res) => {
  // The "app" part of the answer depends on who is asking, so a shared cache
  // must not hand one app's answer to another.
  res.set("Cache-Control", "private, max-age=60");
  res.set("Vary", "X-App-Name, X-App-Version, X-App-Platform");
  res.json(buildBookingConfig(process.env, req.appClient));
});

module.exports = router;
