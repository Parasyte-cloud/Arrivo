// Driver cash-out (wallet to bank). Drivers only.
//
//   GET  /api/cashout            balance, what can be withdrawn, bank, limits, history
//   GET  /api/cashout/banks      banks to choose from
//   PUT  /api/cashout/bank       save the driver's bank account ({ bankCode, accountNumber })
//   POST /api/cashout/withdraw   ({ amountNaira, idempotencyKey })

const express = require("express");
const { requireAuth, requireRole } = require("../middleware/auth");
const cashout = require("../services/driverCashout");
const { PaystackError } = require("../services/paystackTransfers");

const router = express.Router();
router.use(requireAuth, requireRole("driver"));

function handle(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (error) {
      if (error instanceof cashout.CashoutError) {
        return res.status(error.status).json({ error: error.message, code: error.code });
      }
      if (error instanceof PaystackError) {
        return res.status(503).json({ error: "The bank service is unavailable right now. Try again in a moment.", code: "BANK_SERVICE_UNAVAILABLE" });
      }
      throw error;
    }
  };
}

router.get("/", handle(async (req, res) => {
  res.json(await cashout.summary(req.user.id));
}));

router.get("/banks", handle(async (req, res) => {
  res.json({ banks: await cashout.listBanks() });
}));

router.put("/bank", handle(async (req, res) => {
  const { bankCode, accountNumber } = req.body || {};
  res.json({ bank: await cashout.saveBankAccount(req.user.id, { bankCode, accountNumber }) });
}));

router.post("/withdraw", handle(async (req, res) => {
  const { amountNaira, idempotencyKey } = req.body || {};
  const result = await cashout.requestCashout(req.user.id, { amountNaira, idempotencyKey });
  res.status(result.duplicate ? 200 : 201).json(result);
}));

module.exports = router;
