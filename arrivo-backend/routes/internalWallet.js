// Wallet API for other Arrivo services. Signed service calls only (see
// services/walletServiceAuth.js); the service is the one that signed, never
// one named in the body.
//
//   POST /api/internal/wallet/resolve              { email } -> rider + balance
//   POST /api/internal/wallet/balance              { riderUserId } -> balance
//   POST /api/internal/wallet/holds                { riderUserId, amountNaira, idempotencyKey, externalRef, ttlMinutes? }
//   POST /api/internal/wallet/holds/:ref/capture   { amountNaira? }  keep the money (a smaller amount returns the rest)
//   POST /api/internal/wallet/holds/:ref/release   give it all back
//   GET  /api/internal/wallet/holds?status=captured&since=ISO   this service's holds, for its cross-check
//   GET  /api/internal/wallet/holds/:ref           status

const express = require("express");
const { requireService } = require("../services/walletServiceAuth");
const holds = require("../services/walletHolds");

const router = express.Router();
router.use(requireService);

function handle(fn) {
  return async (req, res) => {
    try {
      res.json(await fn(req));
    } catch (error) {
      if (error instanceof holds.WalletHoldError) return res.status(error.status).json({ error: error.message, code: error.code });
      console.error("[internal wallet]", error.message);
      res.status(500).json({ error: "Wallet service error", code: "SERVER" });
    }
  };
}

router.post("/resolve", handle((req) => holds.resolveRider(req.body.email)));

router.post("/balance", handle((req) => holds.balanceOf(Number(req.body.riderUserId))));

router.post("/holds", handle(async (req) => {
  const { riderUserId, amountNaira, idempotencyKey, externalRef, ttlMinutes } = req.body;
  return holds.placeHold({ service: req.service, userId: Number(riderUserId), amountNaira, idempotencyKey, externalRef, ttlMinutes });
}));

router.post("/holds/:ref/capture", handle((req) =>
  holds.capture({ service: req.service, externalRef: req.params.ref, amountNaira: req.body.amountNaira })));

router.post("/holds/:ref/release", handle((req) => holds.release({ service: req.service, externalRef: req.params.ref })));

router.get("/holds", handle((req) => holds.listHolds({ service: req.service, status: req.query.status, since: req.query.since, limit: req.query.limit })));

router.get("/holds/:ref", handle((req) => holds.getHold({ service: req.service, externalRef: req.params.ref })));

module.exports = router;
