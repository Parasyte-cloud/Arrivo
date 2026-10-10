// Admin controls for ArrivoExpress pricing and driver quests.
//
//   GET   /api/admin/express/prices             prices in force now, per tier
//   GET   /api/admin/express/prices/history     every published price, newest first
//   POST  /api/admin/express/prices             publish new prices (now or scheduled)
//   POST  /api/admin/express/samples            log a competitor fare for the same trip
//   POST  /api/admin/express/samples/bulk      log up to 100 competitor fares at once, all or nothing
//   GET   /api/admin/express/samples/routes    the standard trips to price-check each day
//   GET   /api/admin/express/samples/coverage  how much data automatic repricing still needs, per tier
//   GET   /api/admin/express/comparison         us vs the market, per tier, last N days
//   GET   /api/admin/express/quests             all quests with winners and money owed
//   POST  /api/admin/express/quests             create a quest
//   POST  /api/admin/express/quests/:id/end     stop a quest counting new trips
//   GET   /api/admin/express/payouts            quest rewards owed or paid
//   POST  /api/admin/express/payouts/:id/paid   mark a reward as paid (money sent outside the app)
//   POST  /api/admin/express/payouts/:id/pay-wallet   credit a reward to the driver's wallet now
//   POST  /api/admin/express/payouts/pay-all-owed     credit every owed reward ({ confirm: true })
//   GET   /api/admin/express/automation         switches, limits, recent automatic actions
//   PATCH /api/admin/express/automation         turn auto payout / auto repricing on or off
//   GET   /api/admin/express/reprice/plan       what automatic repricing would do right now
//   POST  /api/admin/express/reprice/apply      apply that plan now (same guard rails)
//
// Admin only, reads included: these are money settings. The "operations"
// role is read-only elsewhere in the admin area and is not given these.

const express = require("express");
const { requireAuth, requireRole } = require("../middleware/auth");
const priceBook = require("../services/instantPriceBook");
const intel = require("../services/instantPriceIntel");
const quests = require("../services/driverQuests");
const questPayout = require("../services/questPayout");
const autoReprice = require("../services/autoReprice");
const systemConfig = require("../services/systemConfig");
const { pool } = require("../db/db");

const router = express.Router();
router.use(requireAuth, requireRole("admin"));

function handle(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (error) {
      if (
        error instanceof priceBook.PriceBookError ||
        error instanceof intel.PriceSampleError ||
        error instanceof quests.QuestError ||
        error instanceof questPayout.PayoutError
      ) {
        return res.status(error.status).json({ error: error.message, code: error.code, details: error.details });
      }
      throw error;
    }
  };
}

function id(req) {
  const n = Number(req.params.id);
  return Number.isInteger(n) && n > 0 ? n : null;
}

router.get("/prices", handle(async (req, res) => {
  res.json({ prices: await priceBook.currentPriceSheet() });
}));

router.get("/prices/history", handle(async (req, res) => {
  res.json({ history: await priceBook.listPriceHistory({ tier: req.query.tier, limit: req.query.limit }) });
}));

router.post("/prices", handle(async (req, res) => {
  const { tiers, effectiveFrom, note, confirmLargeChange } = req.body || {};
  const published = await priceBook.publishPriceBook({
    tiers,
    effectiveFrom,
    note,
    confirmLargeChange: confirmLargeChange === true,
    userId: req.user.id,
  });
  res.status(201).json({ published });
}));

router.post("/samples", handle(async (req, res) => {
  res.status(201).json({ sample: await intel.logSample(req.body, req.user.id) });
}));

router.post("/samples/bulk", handle(async (req, res) => {
  res.status(201).json(await intel.logSamples((req.body || {}).rows, req.user.id));
}));

router.get("/samples/routes", handle(async (req, res) => {
  res.json({ routes: require("../services/standardRoutes").STANDARD_ROUTES });
}));

router.get("/samples/coverage", handle(async (req, res) => {
  res.json(await autoReprice.coverage());
}));

router.get("/comparison", handle(async (req, res) => {
  res.json(await intel.comparison({ days: req.query.days }));
}));

router.get("/quests", handle(async (req, res) => {
  res.json({ quests: await quests.listQuestsForAdmin() });
}));

router.post("/quests", handle(async (req, res) => {
  res.status(201).json(await quests.createQuest(req.body, req.user.id));
}));

router.post("/quests/:id/end", handle(async (req, res) => {
  const questId = id(req);
  if (!questId) return res.status(400).json({ error: "Invalid quest id" });
  res.json(await quests.endQuest(questId));
}));

router.get("/payouts", handle(async (req, res) => {
  const status = ["owed", "paid"].includes(req.query.status) ? req.query.status : undefined;
  res.json({ payouts: await quests.listPayouts({ status }) });
}));

router.post("/payouts/:id/paid", handle(async (req, res) => {
  const payoutId = id(req);
  if (!payoutId) return res.status(400).json({ error: "Invalid payout id" });
  res.json(await quests.markPayoutPaid(payoutId, req.user.id));
}));

router.post("/payouts/pay-all-owed", handle(async (req, res) => {
  if (!req.body || req.body.confirm !== true) {
    return res.status(400).json({ error: "Send { confirm: true } to credit every owed reward to driver wallets." });
  }
  res.json(await questPayout.payAllOwed({ adminId: req.user.id }));
}));

router.post("/payouts/:id/pay-wallet", handle(async (req, res) => {
  const payoutId = id(req);
  if (!payoutId) return res.status(400).json({ error: "Invalid payout id" });
  res.json(await questPayout.payToWallet(payoutId, { adminId: req.user.id }));
}));

const AUTOMATION_KEYS = ["express_auto_payout_enabled", "express_auto_reprice_enabled", "driver_cashout_enabled"];
const LOG_KIND = { express_auto_payout_enabled: "payout", express_auto_reprice_enabled: "reprice", driver_cashout_enabled: "cashout" };

router.get("/automation", handle(async (req, res) => {
  const all = await systemConfig.listConfig();
  const switches = all.filter((c) => AUTOMATION_KEYS.includes(c.key));
  const log = await pool.query(
    `SELECT id, kind, action, detail, created_at AS "createdAt"
       FROM express_automation_log WHERE action <> 'run' ORDER BY created_at DESC, id DESC LIMIT 50`
  );
  res.json({
    switches,
    limits: {
      payoutDailyCapNaira: questPayout.dailyCapNaira(),
      payoutPaidTodayNaira: await questPayout.autoPaidTodayNaira(),
      reprice: autoReprice.settings(),
    },
    log: log.rows,
  });
}));

router.patch("/automation", handle(async (req, res) => {
  const { key, enabled } = req.body || {};
  if (!AUTOMATION_KEYS.includes(key) || typeof enabled !== "boolean") {
    return res.status(400).json({ error: "Send { key, enabled } where key is an ArrivoExpress automation switch and enabled is true or false." });
  }
  await systemConfig.setConfig(key, enabled ? "true" : "false", req.user.id);
  await pool.query(
    "INSERT INTO express_automation_log (kind, action, detail) VALUES ($1, $2, $3::jsonb)",
    [LOG_KIND[key], enabled ? "switched_on" : "switched_off", JSON.stringify({ adminId: req.user.id })]
  );
  res.json({ key, enabled });
}));

router.get("/reprice/plan", handle(async (req, res) => {
  res.json(await autoReprice.planAutoReprice());
}));

router.post("/reprice/apply", handle(async (req, res) => {
  res.json(await autoReprice.applyAutoReprice({ mode: "manual", adminId: req.user.id }));
}));

module.exports = router;
