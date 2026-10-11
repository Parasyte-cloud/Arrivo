// Money that arrived in a way a person has to decide about (see
// payment_exceptions in db/schema.sql). Mounted at /api/admin/payment-exceptions.
//
//   GET   /                 admin and support: the queue (open by default)
//   POST  /:id/resolve      admin: close it after handling it by hand
//   POST  /:id/refund       admin: refund the payment through Paystack
//
// Support can read but not act, like every other admin route.

const express = require("express");
const axios = require("axios");
const { pool } = require("../db/db");
const { requireAuth, requireRole, requireAnyRole } = require("../middleware/auth");

const router = express.Router();
const PAYSTACK_BASE = "https://api.paystack.co";

router.use(requireAuth, requireAnyRole(["admin", "support"]));

const STATUSES = ["open", "resolved", "refund_pending", "refunded", "refund_failed"];

router.get("/", async (req, res) => {
  const status = req.query.status === "all" ? null : STATUSES.includes(req.query.status) ? req.query.status : "open";
  const result = await pool.query(
    `SELECT e.*, u.email AS user_email
       FROM payment_exceptions e LEFT JOIN users u ON u.id = e.user_id
      WHERE ($1::text IS NULL OR e.status = $1)
      ORDER BY e.created_at DESC
      LIMIT 200`,
    [status]
  );
  res.json({ exceptions: result.rows });
});

router.post("/:id/resolve", requireRole("admin"), async (req, res) => {
  const note = typeof req.body?.note === "string" ? req.body.note.trim().slice(0, 1000) : "";
  if (!note) return res.status(400).json({ error: "A note saying what was done is required." });
  const result = await pool.query(
    `UPDATE payment_exceptions
        SET status = 'resolved', resolved_by = $2, resolved_note = $3, resolved_at = now()
      WHERE id = $1 AND status IN ('open', 'refund_failed')
      RETURNING *`,
    [Number(req.params.id) || 0, req.user.id, note]
  );
  if (!result.rows[0]) return res.status(404).json({ error: "No open exception with that id." });
  res.json({ exception: result.rows[0] });
});

// Has this payment already been spent on something real? Refunding money that
// paid for a ride, a top-up, a tip or a membership would give it away twice.
async function referenceIsSpent(reference) {
  const spent = await pool.query(
    `SELECT 1 FROM used_payment_references WHERE reference = $1
     UNION ALL SELECT 1 FROM wallet_transactions WHERE paystack_reference = $1
     UNION ALL SELECT 1 FROM family_wallet_transactions WHERE paystack_reference = $1
     UNION ALL SELECT 1 FROM rides WHERE payment_reference = $1
     LIMIT 1`,
    [reference]
  );
  return spent.rows.length > 0;
}

router.post("/:id/refund", requireRole("admin"), async (req, res) => {
  if (!process.env.PAYSTACK_SECRET_KEY) {
    return res.status(503).json({ error: "PAYSTACK_SECRET_KEY is not configured on the server" });
  }
  const id = Number(req.params.id) || 0;
  const existing = (await pool.query("SELECT * FROM payment_exceptions WHERE id = $1", [id])).rows[0];
  if (!existing) return res.status(404).json({ error: "No exception with that id." });
  if (!["open", "refund_failed"].includes(existing.status)) {
    return res.status(409).json({ error: `This exception is ${existing.status}, so it cannot be refunded again here.` });
  }
  if (await referenceIsSpent(existing.reference)) {
    return res.status(409).json({
      error: "This payment was already used for a ride, top-up or other charge. Refunding it would pay it out twice. Resolve it instead.",
    });
  }

  // Optional partial refund. Defaults to everything that was paid.
  let amountNaira = existing.amount_naira == null ? null : Number(existing.amount_naira);
  if (req.body?.amountNaira !== undefined) {
    const requested = Number(req.body.amountNaira);
    if (!Number.isFinite(requested) || requested <= 0 || (amountNaira != null && requested > amountNaira)) {
      return res.status(400).json({ error: "amountNaira must be more than 0 and no more than the amount paid." });
    }
    amountNaira = requested;
  }

  // Claim it first. A double click, or two admins, cannot both reach Paystack:
  // only the request that flips the status gets to send the refund.
  const claimed = await pool.query(
    `UPDATE payment_exceptions SET status = 'refund_pending'
      WHERE id = $1 AND status IN ('open', 'refund_failed') RETURNING *`,
    [id]
  );
  if (!claimed.rows[0]) return res.status(409).json({ error: "Someone else is already refunding this." });

  try {
    const body = { transaction: existing.reference };
    if (amountNaira != null) body.amount = Math.round(amountNaira * 100); // kobo
    const response = await axios.post(`${PAYSTACK_BASE}/refund`, body, {
      headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
      timeout: 15000,
    });
    const updated = await pool.query(
      `UPDATE payment_exceptions
          SET status = 'refunded', refund_response = $2, resolved_by = $3, resolved_at = now(),
              resolved_note = $4
        WHERE id = $1 RETURNING *`,
      [id, JSON.stringify(response.data?.data || response.data || {}), req.user.id, `Refunded NGN ${amountNaira ?? "full amount"} through Paystack.`]
    );
    // Any other open reason on the same payment is settled by the refund.
    await pool.query(
      `UPDATE payment_exceptions
          SET status = 'resolved', resolved_by = $2, resolved_at = now(), resolved_note = 'Closed by the refund of this payment.'
        WHERE reference = $1 AND id <> $3 AND status = 'open'`,
      [existing.reference, req.user.id, id]
    );
    res.json({ exception: updated.rows[0] });
  } catch (err) {
    const detail = err.response?.data || { message: err.message };
    console.error(`Refund failed for payment exception #${id}:`, JSON.stringify(detail));
    await pool.query(
      "UPDATE payment_exceptions SET status = 'refund_failed', refund_response = $2 WHERE id = $1",
      [id, JSON.stringify(detail)]
    );
    res.status(502).json({ error: "Paystack did not accept the refund. It stays in the queue and can be tried again.", detail: detail.message || null });
  }
});

module.exports = router;
