// Admin controls for ArrivoExpress pricing and driver quests.
//
//   GET   /api/admin/express/prices             prices in force now, per tier
//   GET   /api/admin/express/prices/history     every published price, newest first
//   POST  /api/admin/express/prices             publish new prices (now or scheduled)
//   POST  /api/admin/express/samples            log a competitor fare for the same trip
//   GET   /api/admin/express/comparison         us vs the market, per tier, last N days
//   GET   /api/admin/express/quests             all quests with winners and money owed
//   POST  /api/admin/express/quests             create a quest
//   POST  /api/admin/express/quests/:id/end     stop a quest counting new trips
//   GET   /api/admin/express/payouts            quest rewards owed or paid
//   POST  /api/admin/express/payouts/:id/paid   mark a reward as paid
//
// Admin only, reads included: these are money settings. The "operations"
// role is read-only elsewhere in the admin area and is not given these.

const express = require("express");
const { requireAuth, requireRole } = require("../middleware/auth");
const priceBook = require("../services/instantPriceBook");
const intel = require("../services/instantPriceIntel");
const quests = require("../services/driverQuests");

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
        error instanceof quests.QuestError
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

module.exports = router;
