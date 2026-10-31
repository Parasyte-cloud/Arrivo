// What a booking collects about the flight, and how it is saved.
//
// Collected: flight number, flight date, passenger surname (these drive tracking) and an optional
// PNR (stored encrypted, used by support to confirm the booking with the airline; it cannot be
// used to look a flight up). Older app builds send only a flight number, and some riders typed a
// PNR into it. Those requests are still accepted (legacy mode) and flagged for Ops instead of
// being turned away at checkout.
const input = require("./flightInput");
const vault = require("./pnrVault");

const MESSAGES = {
  pnr_like: "That looks like a booking code (PNR), not a flight number. Enter the flight number printed on your ticket, for example BA75, and put the booking code in the booking code box.",
  format: "Enter your flight number as the airline code and digits, for example BA75 or ET 905.",
  empty: "Flight number is required for airport pickups.",
};

// Returns { error } or { details }. `details` is what the insert and the follow up update use.
function parseFlightBooking(body = {}, { bookingType, now = new Date() } = {}) {
  const hasDate = body.flightDate != null && String(body.flightDate).trim() !== "";
  const wantsFlight = bookingType === "one_way";
  const out = { flightNumber: null, flightDate: null, surname: null, pnr: null, pnrMasked: null, legacyPnrOnly: false };

  const rawFlight = body.flightNumber != null ? String(body.flightNumber).trim() : "";
  if (rawFlight) {
    const f = input.normalizeFlightNumber(rawFlight);
    if (f.ok) out.flightNumber = f.ident;
    else if (f.reason === "pnr_like" && !hasDate && wantsFlight) {
      // An older build: the code goes to the vault, the booking goes through, Ops is told.
      const p = input.normalizePnr(rawFlight);
      if (p.ok) Object.assign(out, { pnr: p.pnr, pnrMasked: p.masked, legacyPnrOnly: true });
    } else return { error: { code: `flight_${f.reason}`, message: MESSAGES[f.reason] || MESSAGES.format } };
  } else if (wantsFlight) {
    return { error: { code: "flight_empty", message: MESSAGES.empty } };
  }

  if (hasDate) {
    const d = input.normalizeFlightDate(body.flightDate, now);
    if (!d.ok) {
      const why = { past: "The flight date is in the past.", too_far: "The flight date is more than a year away.", format: "Enter the flight date as year-month-day." }[d.reason];
      return { error: { code: `flight_date_${d.reason}`, message: why || "Enter a valid flight date." } };
    }
    out.flightDate = d.date;
  }

  if (body.passengerSurname != null && String(body.passengerSurname).trim() !== "") {
    const s = input.normalizeSurname(body.passengerSurname);
    if (!s.ok) return { error: { code: "surname_invalid", message: "Enter the passenger surname as it appears on the ticket." } };
    out.surname = s.surname;
  }

  if (body.pnr != null && String(body.pnr).trim() !== "") {
    const p = input.normalizePnr(body.pnr);
    if (!p.ok) return { error: { code: "pnr_invalid", message: "A booking code is 5 to 8 letters and numbers. You can leave it blank." } };
    out.pnr = p.pnr;
    out.pnrMasked = p.masked;
  }
  return { details: out };
}

// Saved after the ride row exists, because the vault binds the code to the ride id. Runs on the same
// client as the insert, so it commits or rolls back with the booking. Never throws on a missing
// vault key: the PNR is optional, so the booking goes ahead without it and Ops can see why.
async function saveFlightDetails(db, rideId, details, tracking = null) {
  if (!details) return;
  let sealed = null;
  let pnrStored = false;
  if (details.pnr) {
    try { sealed = vault.seal(details.pnr, rideId); pnrStored = true; }
    catch (err) { console.error(`[flight] PNR not stored for ride #${rideId}:`, err.message); }
  }
  const state = details.legacyPnrOnly ? "pnr_only" : tracking?.state || (details.flightNumber ? "unknown" : "no_flight");
  const reason = details.legacyPnrOnly ? "pnr_in_flight_box" : tracking?.reason || null;
  await db.query(
    `UPDATE rides SET flight_date = $2, passenger_surname = $3, pnr_enc = $4, pnr_masked = $5,
            flight_tracking_state = $6, flight_tracking_reason = $7, flight_checked_at = now()
     WHERE id = $1`,
    [rideId, details.flightDate, details.surname, sealed, pnrStored ? details.pnrMasked : null, state, reason]
  );
}

module.exports = { parseFlightBooking, saveFlightDetails, MESSAGES };
