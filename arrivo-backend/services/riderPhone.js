// A rider needs a phone number on file to book, so the driver and our team can
// always reach them. Phone was optional at signup, and Google and Apple
// sign-ins never asked, so some bookings came in with no way to call anyone.
//
// Checked at the quote, which every app and website booking hits before
// payment, and again when the ride is created. A ride that's already been paid
// for is never refused over this (see allowedWithoutPhone), so nobody gets
// charged and then turned away.
//
// The booking can carry the number itself (riderPhone). If it's valid and the
// account has none yet, it's saved, so the rider only gets asked once.

const { isValidPhone, phoneErrorMessage } = require("./phone");

const PHONE_REQUIRED = {
  error: "Please add your phone number so your driver and our team can reach you, then try again. You can also add it under Profile.",
  code: "PHONE_REQUIRED",
};

// Card bookings arrive here after Paystack has taken the money, so those are let
// through. Only card: a wallet or pay-at-pickup booking carrying a reference
// hasn't paid anyone yet, so it gets checked like any other. Card is the
// default when no method is sent, same as POST /api/rides.
function allowedWithoutPhone(body) {
  if (!body || !body.paymentReference) return false;
  return (body.paymentMethod || "card") === "card" && !body.payAtPickup;
}

// { ok: true } or { status, body } to send back.
async function ensureRiderPhone(db, user, riderPhone) {
  if (!user || user.role !== "rider") return { ok: true };

  const provided = typeof riderPhone === "string" ? riderPhone.trim() : "";
  if (provided && !isValidPhone(provided)) {
    return { status: 400, body: { error: phoneErrorMessage("Phone number"), code: "PHONE_INVALID" } };
  }

  const row = (await db.query("SELECT phone, whatsapp_number FROM users WHERE id = $1", [user.id])).rows[0] || {};
  const onFile = [row.phone, row.whatsapp_number].some((p) => isValidPhone(p));

  if (provided && !isValidPhone(row.phone)) {
    // Only fills an empty (or broken) number. Changing a good one stays on Profile.
    await db.query("UPDATE users SET phone = $2 WHERE id = $1", [user.id, provided]);
    return { ok: true };
  }
  if (onFile || provided) return { ok: true };
  return { status: 400, body: PHONE_REQUIRED };
}

module.exports = { ensureRiderPhone, allowedWithoutPhone, PHONE_REQUIRED };
