// Validation for the optional fields the rider app sends with an On the Go
// request when it comes from a booking that was too close for the standard
// flow: the time the rider wanted, which service they were booking, and any
// details. All three are optional so builds already on phones keep working.

const MAX_DETAILS_LENGTH = 1000;
const MAX_SERVICE_LENGTH = 60;
// A request that says it wants a car "yesterday" is a mistake in the form. A
// few minutes of grace covers the gap between the rider typing the time and
// the request arriving.
const PAST_GRACE_MS = 10 * 60 * 1000;
// Sanity ceiling only. On the Go is for trips that are soon, and the real
// advance-booking limit for scheduled services is a separate rule.
const MAX_ADVANCE_DAYS = 60;

// Returns { value } on success or { error } for a 400 response.
function parseOptionalExtras(body, now = Date.now()) {
  const { requestedPickupAt, details, service } = body || {};
  const out = { requestedPickupAt: null, details: null, service: null };

  if (requestedPickupAt != null && requestedPickupAt !== "") {
    const ms = new Date(requestedPickupAt).getTime();
    if (typeof requestedPickupAt !== "string" || !Number.isFinite(ms)) {
      return { error: "requestedPickupAt must be a valid date and time" };
    }
    if (ms < now - PAST_GRACE_MS) return { error: "requestedPickupAt is in the past" };
    if (ms > now + MAX_ADVANCE_DAYS * 24 * 60 * 60 * 1000) {
      return { error: `requestedPickupAt is more than ${MAX_ADVANCE_DAYS} days away` };
    }
    out.requestedPickupAt = new Date(ms).toISOString();
  }

  if (details != null && details !== "") {
    const text = String(details).trim();
    if (text.length > MAX_DETAILS_LENGTH) {
      return { error: `details must be ${MAX_DETAILS_LENGTH} characters or fewer` };
    }
    out.details = text || null;
  }

  if (service != null && service !== "") {
    const text = String(service).trim();
    if (text.length > MAX_SERVICE_LENGTH) {
      return { error: `service must be ${MAX_SERVICE_LENGTH} characters or fewer` };
    }
    out.service = text || null;
  }

  return { value: out };
}

module.exports = { parseOptionalExtras, MAX_DETAILS_LENGTH, MAX_SERVICE_LENGTH, MAX_ADVANCE_DAYS, PAST_GRACE_MS };
