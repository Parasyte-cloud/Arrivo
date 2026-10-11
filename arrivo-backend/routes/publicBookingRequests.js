const express = require("express");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const { pool } = require("../db/db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { computeFare } = require("../services/fare");
const { getNgnPerUsd } = require("../services/fx");
const { initializePaystackTransaction } = require("./payments");
const { sendWhatsAppMessage } = require("../services/whatsapp");
const { isValidPhone, phoneErrorMessage } = require("../services/phone");

const router = express.Router();

// This is the one booking-creation path in the app with no Workspace actor
// in front of it -- a customer stranded by an outage, or whoever is
// helping them (support, a social-media manager, a friend), can be handed
// this link and use it from nothing but a browser. It DOES require the
// customer to actually be signed in (Google, Apple, or email/password --
// see easybook.ridearrivo.com), same account as the app and website. That
// used to not be true: an earlier version of this endpoint found-or-created
// a rider by whatever email the visitor typed in, with no proof they
// actually owned it. Real sign-in closes that gap -- a Google/Apple sign-in
// or a password login proves the account, rather than trusting a text
// field, and findOrCreateOAuthProfile (routes/auth.js) already links a new
// Google/Apple sign-in to an existing email-matched account rather than
// forking a second one, so this can never leave someone with duplicate
// RideArrivo accounts.
//
// Every successful submission starts a real Paystack transaction and sends
// a real WhatsApp message, both of which cost money, so this earns its own
// tighter limiter than anywhere else in the app: 5 submissions per IP per
// hour by default. Keyed by IP rather than user id on purpose -- a stolen
// or shared token account shouldn't get a bigger budget than anyone else.
const submitLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: Number(process.env.PUBLIC_BOOKING_REQUEST_RATE_LIMIT) || 5,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: (req, res) =>
    res.status(429).json({
      error:
        "Too many requests from this connection. Please try again in a little while, or contact support directly.",
    }),
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_VEHICLE_TYPES = ["sedan", "suv", "truck", "pickup"];

const MAX_ADDRESS = 300;
const MAX_FLIGHT = 20;
const MAX_SUBMITTED_VIA = 80;

// POST /api/public/booking-requests
//
// A public version of POST /api/support/assisted-bookings (see that route
// for the fuller design notes) for the one everyday case this is meant to
// cover: a customer who can't get through the normal app/website booking
// flow right now -- an outage, or they found RideArrivo through social
// media and don't have the app yet -- and needs a one-way ride.
// Deliberately narrower than the staff version: one-way trips only, no
// fleet/escort/luxury, no full-day/week/month chauffeur booking. Anything
// outside that stays a staff job through the existing internal route.
//
// Creates only a durable pre-payment request, same as the staff route --
// no ride, no charge, no driver -- and then immediately starts a Paystack
// transaction and sends the link over WhatsApp, so one submission is the
// whole self-service flow: sign in, fill the form, get the link, pay, get
// the ride. The real ride is still only ever created by the verified
// Paystack webhook (routes/payments.js), exactly like every other payment
// path in this codebase.
router.post("/booking-requests", requireAuth, requireRole("rider"), submitLimiter, async (req, res) => {
  const body = req.body || {};

  const riderResult = await pool.query(`SELECT id, name, email, phone FROM users WHERE id = $1`, [req.user.id]);
  const rider = riderResult.rows[0];
  if (!rider) {
    // requireAuth already checked the account still exists, but the row
    // was fetched fresh there, not carried here -- re-check rather than
    // trust req.user's JWT payload, which is just whatever was true when
    // the token was signed up to 7 days ago.
    return res.status(401).json({ error: "This account no longer exists." });
  }

  const idempotencyKey = String(body.idempotencyKey || "").trim();
  if (!UUID_RE.test(idempotencyKey)) {
    return res.status(400).json({ error: "idempotencyKey must be a UUID." });
  }

  const phone = String(body.phone || rider.phone || "").trim();
  if (!isValidPhone(phone)) {
    return res.status(400).json({ error: phoneErrorMessage("WhatsApp number") });
  }

  if (!rider.email) {
    return res.status(400).json({ error: "This account has no email on file -- Paystack needs one to start a payment." });
  }

  const pickupAddress = String(body.pickupAddress || "").trim();
  if (!pickupAddress || pickupAddress.length > MAX_ADDRESS) {
    return res.status(400).json({ error: "Please enter a pickup address." });
  }

  const destinationAddress = String(body.destinationAddress || "").trim();
  if (!destinationAddress || destinationAddress.length > MAX_ADDRESS) {
    return res.status(400).json({ error: "Please enter a drop-off address." });
  }

  const flightNumber = String(body.flightNumber || "").trim();
  if (!flightNumber || flightNumber.length > MAX_FLIGHT) {
    return res.status(400).json({ error: "Please enter your flight number." });
  }

  const vehicleType = String(body.vehicleType || "").trim().toLowerCase();
  if (!ALLOWED_VEHICLE_TYPES.includes(vehicleType)) {
    return res.status(400).json({ error: `vehicleType must be one of: ${ALLOWED_VEHICLE_TYPES.join(", ")}` });
  }

  const adults = Number(body.adults ?? 1);
  if (!Number.isInteger(adults) || adults < 1 || adults > 20) {
    return res.status(400).json({ error: "adults must be a whole number from 1 to 20." });
  }

  const children = Number(body.children ?? 0);
  if (!Number.isInteger(children) || children < 0 || children > 20) {
    return res.status(400).json({ error: "children must be a whole number from 0 to 20." });
  }

  const agreedCancellationPolicy = body.agreedCancellationPolicy === true;
  if (!agreedCancellationPolicy) {
    return res.status(400).json({ error: "Please confirm you agree to the Cancellation & Refund Policy." });
  }

  const submittedVia = String(body.submittedVia || "").trim().slice(0, MAX_SUBMITTED_VIA) || null;

  const passengerCount = adults + children;

  const normalizedRequest = {
    bookingType: "one_way",
    pickupAddress,
    destinationAddress,
    flightNumber,
    vehicleType,
    durationDays: 1,
    adults,
    children,
    passengerCount,
    securityEscort: false,
    fleetSize: 0,
    luxury: false,
    scheduledPickupAt: null,
    agreedCancellationPolicy: true,
  };

  const requestFingerprint = crypto
    .createHash("sha256")
    .update(JSON.stringify({ riderId: rider.id, ...normalizedRequest }))
    .digest("hex");

  const existingBooking = await pool.query(
    `SELECT * FROM support_assisted_bookings WHERE idempotency_key = $1`,
    [idempotencyKey]
  );

  if (existingBooking.rows[0]) {
    const prior = existingBooking.rows[0];
    if (prior.source !== "public_self_service" || prior.request_fingerprint !== requestFingerprint) {
      return res.status(409).json({ error: "That request has already been used." });
    }
    return res.status(200).json({
      ok: true,
      fareNaira: prior.fare_naira,
      authorizationUrl: prior.payment_link_url,
      whatsappSent: !!prior.payment_link_sent_at,
      message: prior.payment_link_url
        ? "You already have a payment link for this request -- check your WhatsApp, or use the pay button below."
        : "Your request was already received. Our team will follow up shortly.",
    });
  }

  const ngnPerUsd = await getNgnPerUsd();

  let fareNaira;
  try {
    fareNaira = await computeFare({
      bookingType: "one_way",
      pickupAddress,
      destinationAddress,
      vehicleType,
      securityEscort: false,
      fleetSize: 0,
      luxury: false,
      ngnPerUsd,
      durationDays: 1,
      passengerCount,
    });
  } catch (error) {
    return res.status(400).json({
      error: error instanceof Error ? error.message : "Unable to calculate the fare for this trip.",
    });
  }

  const quotedUsdAmount = Number((Number(fareNaira) / Number(ngnPerUsd)).toFixed(2));

  let booking;
  try {
    const inserted = await pool.query(
      `INSERT INTO support_assisted_bookings (
         rider_id,
         idempotency_key,
         request_fingerprint,
         source,
         payment_method,
         payment_status,
         payment_status_at_creation,
         booking_request,
         fare_naira,
         quoted_ngn_per_usd,
         quoted_usd_amount,
         submitted_via,
         submitted_via_ip
       )
       VALUES (
         $1,$2,$3,'public_self_service',
         'card','pending','pending',
         $4::jsonb,$5,$6,$7,$8,$9
       )
       RETURNING *`,
      [
        rider.id,
        idempotencyKey,
        requestFingerprint,
        JSON.stringify(normalizedRequest),
        fareNaira,
        ngnPerUsd,
        quotedUsdAmount,
        submittedVia,
        req.ip || null,
      ]
    );
    booking = inserted.rows[0];
  } catch (error) {
    if (error?.code === "23505") {
      const raced = await pool.query(
        `SELECT * FROM support_assisted_bookings WHERE idempotency_key = $1`,
        [idempotencyKey]
      );
      const prior = raced.rows[0];
      if (prior && prior.source === "public_self_service" && prior.request_fingerprint === requestFingerprint) {
        booking = prior;
      } else {
        return res.status(409).json({ error: "That request has already been used." });
      }
    } else {
      throw error;
    }
  }

  // The booking row above is durable the moment it's inserted -- staff
  // can always find and finish it through the internal payment-link
  // route even if everything below this point fails. Paystack and
  // WhatsApp are best-effort from here on; a failure here is reported
  // back but doesn't undo the booking.
  let authorizationUrl = booking.payment_link_url;
  let reference = booking.payment_reference;
  let paymentLinkGenerated = !!authorizationUrl;

  if (!authorizationUrl) {
    try {
      const initialized = await initializePaystackTransaction({
        email: rider.email,
        amountNaira: Number(booking.fare_naira),
      });
      authorizationUrl = initialized.authorizationUrl;
      reference = initialized.reference;

      await pool.query(
        `UPDATE support_assisted_bookings
         SET payment_reference = $1, payment_link_url = $2, payment_link_sent_at = now(), updated_at = now()
         WHERE id = $3`,
        [reference, authorizationUrl, booking.id]
      );
      paymentLinkGenerated = true;
    } catch (err) {
      console.error("Public booking-request Paystack initialize failed:", err.response?.data || err.message);
    }
  }

  let whatsappSent = false;
  if (authorizationUrl) {
    const fareDisplay = "NGN " + Number(booking.fare_naira).toLocaleString("en-NG");
    const message =
      `Hi ${rider.name || "there"}, here's your RideArrivo payment link for ${fareDisplay}: ${authorizationUrl}

` +
      `Your ride is booked as soon as this is paid. If you didn't request this, please ignore.`;
    try {
      const sendResult = await sendWhatsAppMessage(phone, message);
      whatsappSent = !!sendResult?.ok;
    } catch (err) {
      console.error("Public booking-request WhatsApp send failed:", err.message);
    }
  }

  return res.status(201).json({
    ok: true,
    fareNaira: Number(booking.fare_naira),
    authorizationUrl: paymentLinkGenerated ? authorizationUrl : null,
    whatsappSent,
    message: paymentLinkGenerated
      ? whatsappSent
        ? "Your fare is locked in. We've sent your payment link to your WhatsApp -- or use the pay button below."
        : "Your fare is locked in. Use the pay button below to complete your booking (we couldn't send WhatsApp automatically)."
      : "Your request was received, but we couldn't start payment automatically. Our team will follow up shortly.",
  });
});

module.exports = router;
