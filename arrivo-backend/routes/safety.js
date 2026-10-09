// Trip safety endpoints for riders and drivers.
//
//   GET    /api/safety/rides/:id/pin          rider: the pickup PIN (only while it is needed)
//   POST   /api/safety/rides/:id/pin/verify  driver: { pin } before starting the trip
//   POST   /api/safety/rides/:id/share       rider/driver: make a new expiring link
//   GET    /api/safety/rides/:id/share       list active links (never the tokens)
//   DELETE /api/safety/rides/:id/share       stop sharing: every link dies now
//   GET    /api/safety/track/:token          PUBLIC: what a link holder may see
//   GET    /api/safety/selfie/status         driver: do I need a selfie, and the code to show
//   POST   /api/safety/selfie                driver: { imageDataUrl, challenge }
//   GET    /api/safety/complaints/categories reasons for the caller's role
//   POST   /api/safety/complaints            { rideId, category, description, photoDataUrl }
//   GET    /api/safety/complaints/mine       my own reports and their outcome

const express = require("express");
const rateLimit = require("express-rate-limit");
const { requireAuth, requireRole } = require("../middleware/auth");
const pickupPin = require("../services/pickupPin");
const shareLinks = require("../services/shareLinks");
const selfie = require("../services/driverSelfie");
const complaints = require("../services/complaints");

const router = express.Router();

const ERRORS = [pickupPin.PinError, shareLinks.ShareError, selfie.SelfieError, complaints.ComplaintError];
function handle(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (error) {
      if (ERRORS.some((E) => error instanceof E)) {
        return res.status(error.status).json({ error: error.message, code: error.code, ...(error.extra || {}) });
      }
      console.error("[safety]", error);
      res.status(500).json({ error: "Something went wrong. Please try again." });
    }
  };
}
const rideIdOf = (req) => (Number.isInteger(Number(req.params.id)) && Number(req.params.id) > 0 ? Number(req.params.id) : null);

const publicLimiter = rateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false });
const pinLimiter = rateLimit({ windowMs: 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });
const fileLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });

// Public, no login. Registered before the auth wall below.
router.get("/track/:token", publicLimiter, handle(async (req, res) => {
  const out = await shareLinks.resolvePublic(req.params.token);
  if (out.error) return res.status(out.error.status).json({ error: out.error.message, reason: out.error.reason });
  res.json(out.view);
}));

router.use(requireAuth);

router.get("/rides/:id/pin", requireRole("rider"), handle(async (req, res) => {
  const id = rideIdOf(req);
  if (!id) return res.status(400).json({ error: "Invalid ride id" });
  res.json(await pickupPin.getPinForRider(id, req.user.id));
}));

router.post("/rides/:id/pin/verify", pinLimiter, requireRole("driver"), handle(async (req, res) => {
  const id = rideIdOf(req);
  if (!id) return res.status(400).json({ error: "Invalid ride id" });
  res.json(await pickupPin.verifyPin(id, req.user.id, req.body?.pin));
}));

router.post("/rides/:id/share", handle(async (req, res) => {
  const id = rideIdOf(req);
  if (!id) return res.status(400).json({ error: "Invalid ride id" });
  const { token, expiresAt } = await shareLinks.createLink(id, req.user);
  const base = process.env.TRACK_SHARE_BASE_URL || "https://ridearrivo.com/track.html";
  res.status(201).json({ shareUrl: `${base}${base.includes("?") ? "" : "?share="}${token}`, expiresAt });
}));

router.get("/rides/:id/share", handle(async (req, res) => {
  const id = rideIdOf(req);
  if (!id) return res.status(400).json({ error: "Invalid ride id" });
  res.json(await shareLinks.listActive(id, req.user));
}));

router.delete("/rides/:id/share", handle(async (req, res) => {
  const id = rideIdOf(req);
  if (!id) return res.status(400).json({ error: "Invalid ride id" });
  res.json(await shareLinks.revokeAll(id, req.user));
}));

router.get("/selfie/status", requireRole("driver"), handle(async (req, res) => {
  const d = await require("../routes/drivers").getDriverForUser(req.user.id);
  if (!d) return res.status(404).json({ error: "Complete your driver profile first" });
  res.json(await selfie.status(d.id));
}));

router.post("/selfie", fileLimiter, requireRole("driver"), handle(async (req, res) => {
  const d = await require("../routes/drivers").getDriverForUser(req.user.id);
  if (!d) return res.status(404).json({ error: "Complete your driver profile first" });
  res.status(201).json(await selfie.submitSelfie(d.id, req.body || {}));
}));

router.get("/complaints/categories", requireAnyOfRiderDriver, (req, res) => {
  res.json({ categories: complaints.categoriesFor(req.user.role) });
});

router.post("/complaints", fileLimiter, requireAnyOfRiderDriver, handle(async (req, res) => {
  const b = req.body || {};
  res.status(201).json(await complaints.fileComplaint(req.user.id, {
    rideId: Number(b.rideId), category: b.category, description: b.description, photoDataUrl: b.photoDataUrl,
  }));
}));

router.get("/complaints/mine", requireAnyOfRiderDriver, handle(async (req, res) => {
  res.json({ complaints: await complaints.listMine(req.user.id) });
}));

function requireAnyOfRiderDriver(req, res, next) {
  if (!["rider", "driver"].includes(req.user?.role)) return res.status(403).json({ error: "Only riders and drivers can file reports." });
  next();
}

module.exports = router;
