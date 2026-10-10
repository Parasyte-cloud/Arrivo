// Admin view of driver cash-outs. Admin only (operations is read-only and is
// not given money screens).
//
//   GET  /api/admin/cashouts?status=      list
//   POST /api/admin/cashouts/:id/approve  release one that is waiting for review
//   POST /api/admin/cashouts/:id/decline  refuse it ({ reason }); the money goes back to the driver
//   POST /api/admin/cashouts/:id/check    ask Paystack what happened to one in flight

const express = require("express");
const { requireAuth, requireRole } = require("../middleware/auth");
const cashout = require("../services/driverCashout");

const router = express.Router();
router.use(requireAuth, requireRole("admin"));

function handle(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (error) {
      if (error instanceof cashout.CashoutError) return res.status(error.status).json({ error: error.message, code: error.code });
      throw error;
    }
  };
}
const idOf = (req) => (Number.isInteger(Number(req.params.id)) && Number(req.params.id) > 0 ? Number(req.params.id) : null);
const STATUSES = ["pending_review", "queued", "processing", "paid", "failed", "rejected", "reversed"];

router.get("/", handle(async (req, res) => {
  const status = STATUSES.includes(req.query.status) ? req.query.status : undefined;
  res.json({ cashouts: await cashout.listForAdmin({ status }) });
}));

router.post("/:id/approve", handle(async (req, res) => {
  const id = idOf(req);
  if (!id) return res.status(400).json({ error: "Invalid id" });
  res.json(await cashout.approve(id, req.user.id));
}));

router.post("/:id/decline", handle(async (req, res) => {
  const id = idOf(req);
  if (!id) return res.status(400).json({ error: "Invalid id" });
  res.json(await cashout.reject(id, req.user.id, req.body && req.body.reason));
}));

router.post("/:id/check", handle(async (req, res) => {
  const id = idOf(req);
  if (!id) return res.status(400).json({ error: "Invalid id" });
  res.json(await cashout.verifyAndSettle(id));
}));

module.exports = router;
