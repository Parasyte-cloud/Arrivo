// Validation for EasyBook requests (easybookings.ridearrivo.com).
//
// EasyBook is the assisted booking page: a customer, or someone helping them
// (support, a social media manager, a friend), fills it in with no sign-in.
// It covers every RideArrivo trip type except ArrivoExpress, which has its own
// product. This file is the single place that decides whether a submission is
// acceptable, so the quote endpoint and the submit endpoint can never disagree.
//
// Pure functions only: no database, no network. That keeps them easy to test
// and means the rules cannot drift between the two endpoints.

const { isValidPhone, phoneErrorMessage } = require("./phone");
const { isStandardBookingBlocked, blockedBookingResponse } = require("./bookingWindow");
const { MAX_FULL_DAY_COUNT } = require("./fare");

const BOOKING_TYPES = ["one_way", "dropoff", "full_day", "full_week", "full_month"];
const VEHICLE_TYPES = ["sedan", "suv", "truck", "pickup"];
const CHARTER_TYPES = ["full_day", "full_week", "full_month"];

const MAX_ADDRESS = 300;
const MAX_FLIGHT = 20;
const MAX_NAME = 100;
const MAX_EMAIL = 254;
const MAX_NOTES = 500;
const MAX_HELPER = 80;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function fail(error, extra) {
  return { ok: false, status: 400, body: { error, ...(extra || {}) } };
}

function str(value) {
  return String(value == null ? "" : value).trim();
}

// Validates the trip itself (everything the fare depends on, plus the details
// ops need). Used by both /quote and /requests.
function validateTrip(body, { now = Date.now() } = {}) {
  const b = body || {};

  const bookingType = str(b.bookingType).toLowerCase();
  if (!BOOKING_TYPES.includes(bookingType)) {
    return fail(`bookingType must be one of: ${BOOKING_TYPES.join(", ")}`);
  }

  const vehicleType = str(b.vehicleType).toLowerCase();
  if (!VEHICLE_TYPES.includes(vehicleType)) {
    return fail(`vehicleType must be one of: ${VEHICLE_TYPES.join(", ")}`);
  }

  const isCharter = CHARTER_TYPES.includes(bookingType);

  const pickupAddress = str(b.pickupAddress);
  if (!pickupAddress || pickupAddress.length > MAX_ADDRESS) {
    return fail(isCharter ? "Please enter where the driver should meet you." : "Please enter a pickup address.");
  }

  const destinationAddress = str(b.destinationAddress);
  if (destinationAddress.length > MAX_ADDRESS) {
    return fail("The drop-off address is too long.");
  }
  if (!isCharter && !destinationAddress) {
    return fail("Please enter a drop-off address.");
  }

  const flightNumber = str(b.flightNumber);
  if (flightNumber.length > MAX_FLIGHT) {
    return fail("That flight number looks too long.");
  }
  if (bookingType === "one_way" && !flightNumber) {
    return fail("Please enter the flight number so we can track the landing.");
  }

  const adults = Number(b.adults ?? 1);
  if (!Number.isInteger(adults) || adults < 1 || adults > 20) {
    return fail("Adults must be a whole number from 1 to 20.");
  }
  const children = Number(b.children ?? 0);
  if (!Number.isInteger(children) || children < 0 || children > 20) {
    return fail("Children must be a whole number from 0 to 20.");
  }

  let durationDays = 1;
  if (bookingType === "full_day") {
    durationDays = Number(b.durationDays ?? 1);
    if (!Number.isInteger(durationDays) || durationDays < 1 || durationDays > MAX_FULL_DAY_COUNT) {
      return fail(`Number of days must be from 1 to ${MAX_FULL_DAY_COUNT}.`);
    }
  }

  // Pickup time. Required for drop-offs and every chauffeur booking, optional
  // for an airport pickup (those are timed off the flight, see
  // services/bookingWindow.js).
  let scheduledPickupAt = null;
  const rawWhen = str(b.scheduledPickupAt);
  if (rawWhen) {
    const parsed = new Date(rawWhen);
    if (Number.isNaN(parsed.getTime())) {
      return fail("That pickup date and time is not valid.");
    }
    if (parsed.getTime() < now) {
      return fail("The pickup date and time must be in the future.");
    }
    if (isStandardBookingBlocked(parsed, now)) {
      return { ok: false, status: 400, body: blockedBookingResponse() };
    }
    scheduledPickupAt = parsed.toISOString();
  } else if (bookingType === "dropoff") {
    return fail("Please choose the pickup date and time for your airport drop-off.");
  } else if (isCharter) {
    return fail("Please choose the date and time the driver should start.");
  }

  const flightDate = str(b.flightDate).slice(0, 40);
  const notes = str(b.notes);
  if (notes.length > MAX_NOTES) {
    return fail(`Notes can be at most ${MAX_NOTES} characters.`);
  }

  const securityEscort = b.securityEscort === true;
  const luxury = b.luxury === true;

  return {
    ok: true,
    value: {
      bookingType,
      vehicleType,
      pickupAddress,
      destinationAddress: destinationAddress || null,
      flightNumber: flightNumber || null,
      flightDate: flightDate || null,
      durationDays,
      adults,
      children,
      passengerCount: adults + children,
      securityEscort,
      fleetSize: 0,
      luxury,
      scheduledPickupAt,
      notes: notes || null,
    },
  };
}

// Validates who the booking is for and how to reach them.
function validateContact(body) {
  const b = body || {};

  const name = str(b.name).replace(/\s+/g, " ");
  if (name.length < 2 || name.length > MAX_NAME) {
    return fail("Please enter the passenger's full name.");
  }

  const email = str(b.email).toLowerCase();
  if (!email || email.length > MAX_EMAIL || !EMAIL_RE.test(email)) {
    return fail("Please enter a valid email address. The invoice and receipt are sent there.");
  }

  const phone = str(b.phone);
  if (!isValidPhone(phone)) {
    return fail(phoneErrorMessage("WhatsApp number"));
  }

  return { ok: true, value: { name, email, phone } };
}

// Full submission: contact + trip + the agreement + who is helping.
function validateSubmission(body, opts) {
  const contact = validateContact(body);
  if (!contact.ok) return contact;
  const trip = validateTrip(body, opts);
  if (!trip.ok) return trip;

  if ((body || {}).agreedCancellationPolicy !== true) {
    return fail("Please confirm you agree to the Cancellation & Refund Policy.");
  }

  const helperName = str((body || {}).helperName).slice(0, MAX_HELPER);

  return { ok: true, value: { contact: contact.value, trip: trip.value, helperName: helperName || null } };
}

module.exports = {
  BOOKING_TYPES,
  VEHICLE_TYPES,
  CHARTER_TYPES,
  validateTrip,
  validateContact,
  validateSubmission,
};
