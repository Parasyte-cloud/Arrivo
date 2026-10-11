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

// A Paystack reference goes into a URL path (/transaction/verify/<reference>)
// that is called with the merchant secret key. Anything that is not a plain
// reference token must never reach that URL: axios normalises "../123456" to
// "/transaction/123456", which is Paystack's "fetch any transaction by id"
// call, and that would let a caller present someone else's successful payment
// as their own. Paystack itself only issues letters, digits and - . = _ so
// that is all that is allowed, with no ".." and no leading dot.
const PAYSTACK_REFERENCE = /^[A-Za-z0-9=_-][A-Za-z0-9._=-]{3,99}$/;

function isValidPaystackReference(reference) {
  return (
    typeof reference === "string" &&
    PAYSTACK_REFERENCE.test(reference) &&
    !reference.includes("..")
  );
}

module.exports = { claimPaymentReference, isValidPaystackReference };
