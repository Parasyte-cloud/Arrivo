// Cross-subsystem payment-reference ledger — see db/schema.sql's
// used_payment_references table for the full reasoning. A single real,
// successfully-verified Paystack reference must only ever be spent ONCE, no
// matter which of the four flows that accept one (ride card payment, ride
// tip, ride overage charge, wallet top-up) it's presented to — otherwise the
// same real payment could be "spent" more than once across flows.
//
// Callers must invoke this INSIDE an already-open transaction (BEGIN
// already called on dbClient) and treat a `false` return the same as any
// other validation failure: ROLLBACK and reject the request. Wrapping the
// claim and the actual payment-marking UPDATE in one transaction means they
// either both commit or both roll back together, and the UNIQUE constraint
// on `reference` makes the claim itself atomic even if two requests race
// with the same reference at the same instant — a SELECT-then-UPDATE check
// can't guarantee that, since both concurrent SELECTs could see "not used
// yet" before either UPDATE lands.
//
// Returns true if this call successfully claimed the reference (safe to
// proceed), false if it was already claimed by anything else (reject).
async function claimPaymentReference(dbClient, reference, usedFor, rideId = null) {
  const result = await dbClient.query(
    `INSERT INTO used_payment_references (reference, used_for, ride_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (reference) DO NOTHING
     RETURNING id`,
    [reference, usedFor, rideId]
  );
  return result.rows.length > 0;
}

module.exports = { claimPaymentReference };
