// Driver tiers in the ops console.
//
//   GET  /api/admin/driver-tiers                 drivers with their seven tiers (?q= name, email, plate or id)
//   POST /api/admin/driver-tiers/grant           { driverId, tier, note? }
//   POST /api/admin/driver-tiers/revoke          { driverId, tier, note }   (a reason is required)
//   GET  /api/admin/driver-tiers/events/:driverId  the history for one driver
//
// Access is the "driver-tiers" console area (services/staffAccess.js): the
// owner has it, an admin does not unless the owner gives it, and view lets
// someone look without changing anything. requireAuth already enforces that
// from the path, the checks below only make sure it ran.
const express = require("express");
const { pool } = require("../db/db");
const { requireAuth, requireAnyRole } = require("../middleware/auth");
const access = require("../services/staffAccess");
const { createDriverTiers, TierError } = require("../services/driverTiers");

const router = express.Router();
const tiers = createDriverTiers(pool);

router.use(requireAuth, requireAnyRole(access.STAFF_ROLES), (req, res, next) => {
  if (!req.staffAccess?.ok || req.staffAccess.area !== "driver-tiers") {
    return res.status(403).json({ error: "You don't have access to driver tiers. Ask the owner.", code: "NO_ACCESS" });
  }
  next();
});

const id = (v) => (/^\d+$/.test(String(v)) ? Number(v) : null);
const fail = (res, e) => {
  if (e instanceof TierError) return res.status(e.status).json({ error: e.message, code: e.code });
  throw e;
};

router.get("/", async (req, res) => {
  const out = await tiers.overview({ q: req.query.q });
  const me = req.staffAccess;
  res.json({ ...out, you: { canManage: me.has === "manage" } });
});

router.post("/grant", async (req, res) => {
  const driverId = id(req.body?.driverId);
  if (!driverId) return res.status(400).json({ error: "Choose a driver.", code: "driver_invalid" });
  try {
    const out = await tiers.grant({ driverId, tier: req.body?.tier, actorId: req.user.id, note: req.body?.note });
    res.json({ ok: true, ...out, tiers: await tiers.listForDriver(driverId) });
  } catch (e) { fail(res, e); }
});

router.post("/revoke", async (req, res) => {
  const driverId = id(req.body?.driverId);
  if (!driverId) return res.status(400).json({ error: "Choose a driver.", code: "driver_invalid" });
  try {
    const out = await tiers.revoke({ driverId, tier: req.body?.tier, actorId: req.user.id, note: req.body?.note });
    res.json({ ok: true, ...out, tiers: await tiers.listForDriver(driverId) });
  } catch (e) { fail(res, e); }
});

router.get("/events/:driverId", async (req, res) => {
  const driverId = id(req.params.driverId);
  if (!driverId) return res.status(400).json({ error: "Choose a driver.", code: "driver_invalid" });
  res.json({ events: await tiers.events(driverId) });
});

module.exports = router;
