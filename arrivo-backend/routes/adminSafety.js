// Admin side of trip safety. Admin only (support/operations are read-only
// elsewhere and are not given these actions).
//
//   GET   /api/admin/safety/overview            counts + switches
//   PATCH /api/admin/safety/switches            { key, enabled }
//   GET   /api/admin/safety/complaints          ?status=&priority=
//   PATCH /api/admin/safety/complaints/:id      { status, resolution, action }
//   GET   /api/admin/safety/selfies             pending selfies to review
//   POST  /api/admin/safety/selfies/:id/review  { decision, note }
//   POST  /api/admin/safety/drivers/:id/recheck force a new selfie
//   POST  /api/admin/safety/rides/:id/pin-override { note } (min 10 chars)
//   GET   /api/admin/safety/events              latest audit entries

const express = require("express");
const { requireAuth, requireRole } = require("../middleware/auth");
const pool = () => require("../db/db").pool;
const systemConfig = require("../services/systemConfig");
const pickupPin = require("../services/pickupPin");
const selfie = require("../services/driverSelfie");
const complaints = require("../services/complaints");
const { logSafetyEvent } = require("../services/safetyEvents");

const router = express.Router();
router.use(requireAuth, requireRole("admin"));

const SWITCHES = ["safety_pickup_pin_required", "safety_selfie_required"];
const ERRORS = [pickupPin.PinError, selfie.SelfieError, complaints.ComplaintError];
function handle(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (error) {
      if (ERRORS.some((E) => error instanceof E)) return res.status(error.status).json({ error: error.message, code: error.code });
      console.error("[admin safety]", error);
      res.status(500).json({ error: "Something went wrong." });
    }
  };
}
const idOf = (req) => (Number.isInteger(Number(req.params.id)) && Number(req.params.id) > 0 ? Number(req.params.id) : null);

router.get("/overview", handle(async (req, res) => {
  const [c, s, p, sw] = await Promise.all([
    pool().query(`SELECT count(*) FILTER (WHERE status IN ('open','investigating'))::int AS open,
                         count(*) FILTER (WHERE status IN ('open','investigating') AND priority = 'urgent')::int AS urgent,
                         count(*) FILTER (WHERE status IN ('open','investigating') AND respond_by < now())::int AS overdue
                    FROM ride_complaints`),
    pool().query("SELECT count(*)::int AS n FROM driver_selfie_checks WHERE status = 'pending'"),
    pool().query("SELECT count(*)::int AS n FROM drivers WHERE express_paused_at IS NOT NULL"),
    Promise.all(SWITCHES.map(async (key) => ({ key, enabled: await systemConfig.getConfigBool(key, false), description: systemConfig.DESCRIPTIONS[key] || null }))),
  ]);
  res.json({ complaints: c.rows[0], pendingSelfies: s.rows[0].n, pausedDrivers: p.rows[0].n, switches: sw });
}));

router.patch("/switches", handle(async (req, res) => {
  const { key, enabled } = req.body || {};
  if (!SWITCHES.includes(key) || typeof enabled !== "boolean") return res.status(400).json({ error: "Send { key, enabled } for a safety switch." });
  await systemConfig.setConfig(key, enabled ? "true" : "false", req.user.id);
  await logSafetyEvent(pool(), enabled ? "switch_on" : "switch_off", { userId: req.user.id, detail: { key } });
  res.json({ key, enabled });
}));

router.get("/complaints", handle(async (req, res) => {
  res.json({ complaints: await complaints.listForAdmin({ status: req.query.status, priority: req.query.priority }) });
}));

router.patch("/complaints/:id", handle(async (req, res) => {
  const id = idOf(req);
  if (!id) return res.status(400).json({ error: "Invalid id" });
  res.json(await complaints.resolve(id, req.user.id, req.body || {}));
}));

router.get("/selfies", handle(async (req, res) => {
  res.json({ selfies: await selfie.listPending({}) });
}));

router.post("/selfies/:id/review", handle(async (req, res) => {
  const id = idOf(req);
  if (!id) return res.status(400).json({ error: "Invalid id" });
  res.json(await selfie.review(id, req.user.id, req.body || {}));
}));

router.post("/drivers/:id/recheck", handle(async (req, res) => {
  const id = idOf(req);
  if (!id) return res.status(400).json({ error: "Invalid id" });
  res.json(await selfie.requireRecheck(id, req.user.id));
}));

router.post("/rides/:id/pin-override", handle(async (req, res) => {
  const id = idOf(req);
  if (!id) return res.status(400).json({ error: "Invalid id" });
  res.json(await pickupPin.override(id, req.user.id, req.body?.note));
}));

router.get("/events", handle(async (req, res) => {
  const r = await pool().query("SELECT id, kind, ride_id, user_id, driver_id, detail, created_at FROM safety_events ORDER BY created_at DESC, id DESC LIMIT 100");
  res.json({ events: r.rows });
}));

module.exports = router;
