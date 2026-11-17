// Finance screens for the shared wallet. Admin only.
//
//   GET  /api/admin/wallet-settlements/report        what each service is owed / still held
//   GET  /api/admin/wallet-settlements               settlements
//   POST /api/admin/wallet-settlements               { service } make one from unsettled captures
//   POST /api/admin/wallet-settlements/:id/approve   { bankReference } a DIFFERENT admin approves
//   POST /api/admin/wallet-settlements/:id/cancel
//   GET  /api/admin/wallet-settlements/payout-float  suggested driver payout float

const express = require("express");
const { requireAuth, requireRole } = require("../middleware/auth");
const settlement = require("../services/walletSettlement");

const router = express.Router();
router.use(requireAuth, requireRole("admin"));

function handle(fn) {
  return async (req, res) => {
    try {
      res.json(await fn(req));
    } catch (error) {
      if (error instanceof settlement.SettlementError) return res.status(error.status).json({ error: error.message, code: error.code });
      throw error;
    }
  };
}
const idOf = (req) => {
  const n = Number(req.params.id);
  if (!Number.isInteger(n) || n <= 0) throw new settlement.SettlementError("Invalid id", 400, "BAD_ID");
  return n;
};

router.get("/report", handle(async () => ({ services: await settlement.report() })));
router.get("/payout-float", handle(() => settlement.payoutFloat()));
router.get("/", handle(async () => ({ settlements: await settlement.list() })));
router.post("/", handle((req) => settlement.create({ service: req.body.service, adminId: req.user.id })));
router.post("/:id/approve", handle((req) => settlement.approve({ id: idOf(req), adminId: req.user.id, bankReference: req.body.bankReference })));
router.post("/:id/cancel", handle((req) => settlement.cancel({ id: idOf(req) })));

module.exports = router;
