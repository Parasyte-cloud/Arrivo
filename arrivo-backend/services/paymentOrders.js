// Pending payment orders and the exceptions queue (see payment_orders and
// payment_exceptions in db/schema.sql for the reasoning).
//
// Everything here is written so it can be called twice with the same input
// and end in the same state, because Paystack retries webhooks and clients
// retry requests.

const ORDER_PURPOSES = ["ride", "wallet_topup", "unknown"];
// A booking payload is a handful of short fields. Anything bigger is not a
// booking, and this column is written from a request that may be anonymous.
const MAX_PAYLOAD_BYTES = 20 * 1024;

function normalisePurpose(purpose) {
  return ORDER_PURPOSES.includes(purpose) ? purpose : "unknown";
}

// Stored only for a signed-in ride order, and only when it is a plain object of
// reasonable size. Returns null when it should not be kept.
function sanitiseRidePayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  let json;
  try {
    json = JSON.stringify(payload);
  } catch (e) {
    return null;
  }
  if (Buffer.byteLength(json, "utf8") > MAX_PAYLOAD_BYTES) return null;
  const copy = JSON.parse(json);
  // The server decides how a webhook-created ride is paid and verified.
  delete copy.paymentReference;
  delete copy.paymentMethod;
  delete copy.validateOnly;
  delete copy.idempotencyKey;
  return copy;
}

// Called when a payment is started. The first writer wins: a reference is
// created once, by Paystack, so a second insert for it is a replay.
async function recordOrder(db, { reference, userId, email, purpose, amountNaira, payload }) {
  const safePurpose = normalisePurpose(purpose);
  // A purpose that acts on a specific account needs a verified account.
  const effectivePurpose = userId ? safePurpose : "unknown";
  const storedPayload = userId && effectivePurpose === "ride" ? sanitiseRidePayload(payload) : null;
  await db.query(
    `INSERT INTO payment_orders (reference, user_id, email, purpose, amount_naira, payload)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (reference) DO NOTHING`,
    [reference, userId || null, email || null, effectivePurpose, amountNaira, storedPayload ? JSON.stringify(storedPayload) : null]
  );
}

// Paystack says this reference was paid. Creates the row if the payment was
// never started through initialize (the website's own checkout popup makes its
// own references), so the sweep can still notice it if nothing ever claims it.
async function markOrderPaid(db, reference, { amountNaira, email } = {}) {
  const result = await db.query(
    `INSERT INTO payment_orders (reference, email, purpose, amount_naira, status, paid_at)
     VALUES ($1, $2, 'unknown', $3, 'paid', now())
     ON CONFLICT (reference) DO UPDATE
       SET status = CASE WHEN payment_orders.status IN ('finalized', 'exception') THEN payment_orders.status ELSE 'paid' END,
           paid_at = COALESCE(payment_orders.paid_at, now()),
           amount_naira = COALESCE(payment_orders.amount_naira, EXCLUDED.amount_naira)
     RETURNING *`,
    [reference, email || null, amountNaira ?? null]
  );
  return result.rows[0];
}

async function markOrderFinalized(db, reference, rideId = null) {
  await db.query(
    `UPDATE payment_orders SET status = 'finalized', ride_id = COALESCE($2, ride_id), finalized_at = now()
      WHERE reference = $1`,
    [reference, rideId]
  );
}

// Writes (or bumps) one exception. Safe to call repeatedly for the same
// reference and reason. Also flags the order so the sweep leaves it alone.
async function recordPaymentException(db, { reference, reason, purpose = null, userId = null, amountNaira = null, details = null }) {
  const result = await db.query(
    `INSERT INTO payment_exceptions (reference, reason, purpose, user_id, amount_naira, details)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (reference, reason) DO UPDATE
       SET occurrences = payment_exceptions.occurrences + 1, last_seen_at = now()
     RETURNING *`,
    [reference, reason, purpose, userId, amountNaira, details ? JSON.stringify(details) : null]
  );
  await db.query(
    `UPDATE payment_orders SET status = 'exception' WHERE reference = $1 AND status <> 'finalized'`,
    [reference]
  );
  console.error(`[payments] exception recorded: ${reason} ref=${reference} amount=${amountNaira}`);
  return result.rows[0];
}

// A retried webhook that finally worked closes the exception its failed
// attempts opened.
async function autoResolveProcessingErrors(db, reference) {
  await db.query(
    `UPDATE payment_exceptions
        SET status = 'resolved', resolved_at = now(), resolved_note = 'Resolved automatically: a webhook retry succeeded.'
      WHERE reference = $1 AND reason = 'processing_error' AND status = 'open'`,
    [reference]
  );
}

module.exports = {
  ORDER_PURPOSES,
  MAX_PAYLOAD_BYTES,
  normalisePurpose,
  sanitiseRidePayload,
  recordOrder,
  markOrderPaid,
  markOrderFinalized,
  recordPaymentException,
  autoResolveProcessingErrors,
};
