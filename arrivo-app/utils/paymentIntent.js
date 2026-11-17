// Describes what a card payment is for, so the backend can bind it to the
// right thing later. Phase 1 of the rollout: the app only SENDS this. The
// backend ignores unknown body keys today, so old and new builds both work.
//
// purpose is a small closed set. refId is the ride id when one exists.
export const PAYMENT_PURPOSES = ["topup", "ride", "overage", "tip", "family_topup"];

export function buildPaymentInit({ email, amountNaira, purpose, refId }) {
  const body = { email, amountNaira };
  if (PAYMENT_PURPOSES.includes(purpose)) body.purpose = purpose;
  if (refId !== undefined && refId !== null && String(refId).trim() !== "") body.refId = String(refId);
  return body;
}

export function paymentInitHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}
