// Keeps riders' and drivers' phone numbers out of each other's hands.
//
// Riders and drivers reach each other through in-app calling and chat (see
// routes/calls.js and routes/chat.js), which never shows or needs a number.
// Before this, the ride endpoints returned the other person's phone number in
// plain JSON, including to every approved driver for rides nobody had accepted
// yet, and the public share link returned the driver's.
//
// Rather than edit every SELECT and hope the next one is remembered, the
// middleware below wraps res.json on the ride routes and removes counterparty
// phone fields from anything a rider, a driver or an anonymous visitor
// receives. Staff (admin, support, operations) keep them: they need them to
// look after a trip and they have a legitimate reason.

const COUNTERPARTY_PHONE_KEYS = new Set([
  "rider_phone",
  "driver_phone",
  "rider_whatsapp",
  "rider_whatsapp_number",
  "driver_whatsapp",
  "driver_whatsapp_number",
  "phone_number",
  "contact_phone",
  "owner_whatsapp",
  // Plain "phone" appears on people attached to a ride (shareParticipants
  // are other riders in the party). Only the rider who owns the ride sees them.
  "phone",
]);

// The rider's own emergency contact is for RideArrivo to use if the rider
// cannot be reached. A driver has no use for it, so it is never sent to one.
const EMERGENCY_KEYS = new Set(["emergency_contact_phone"]);

const STAFF_ROLES = new Set(["admin", "support", "operations"]);

function isStaff(user) {
  return !!user && STAFF_ROLES.has(user.role);
}

// Deep copy of `value` with phone-bearing keys removed.
//   viewer: { id, role } or null for an anonymous visitor
// A rider keeps their own number (an object whose rider_id is the viewer) and
// their own emergency contact; everything else about phones goes.
function stripPhones(value, viewer, ctx = {}) {
  if (Array.isArray(value)) return value.map((v) => stripPhones(v, viewer, ctx));
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date || Buffer.isBuffer(value)) return value;

  const viewerId = viewer && viewer.id != null ? Number(viewer.id) : null;
  // A ride the viewer owns passes that fact down to everything nested in it.
  const ownsThisRide =
    !!ctx.ownsRide ||
    (viewerId !== null && value.rider_id !== undefined && Number(value.rider_id) === viewerId);
  const childCtx = ownsThisRide ? { ...ctx, ownsRide: true } : ctx;
  const viewerIsRider = viewer && viewer.role === "rider";

  const out = {};
  for (const [key, v] of Object.entries(value)) {
    if (COUNTERPARTY_PHONE_KEYS.has(key)) {
      // A rider reading their own booking may see the number they gave us.
      if (ownsThisRide && viewerIsRider && (key === "rider_phone" || key === "rider_whatsapp_number" || key === "rider_whatsapp" || (key === "phone" && ctx.parentKey === "shareParticipants"))) {
        out[key] = v;
      }
      continue;
    }
    if (EMERGENCY_KEYS.has(key) && !(ownsThisRide && viewerIsRider)) continue;
    out[key] = stripPhones(v, viewer, { ...childCtx, parentKey: key });
  }
  return out;
}

// Express middleware. Mount it in front of the ride routers:
//   app.use("/api/rides", maskCounterpartyPhones, ridesRouter)
// It reads req.user lazily (set later by requireAuth), at the moment the
// response is sent, so it works for authenticated and public routes alike.
function maskCounterpartyPhones(req, res, next) {
  const original = res.json.bind(res);
  res.json = (body) => {
    if (isStaff(req.user)) return original(body);
    return original(stripPhones(body, req.user || null));
  };
  next();
}

module.exports = { stripPhones, maskCounterpartyPhones, COUNTERPARTY_PHONE_KEYS, isStaff };
