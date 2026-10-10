const express = require("express");
const rateLimit = require("express-rate-limit");
const { requireAuth } = require("../middleware/auth");
const axios = require("axios");
const crypto = require("crypto");
const { pool } = require("../db/db");
const { claimPaymentReference, isValidPaystackReference } = require("../services/paymentReferences");
const { creditWalletTopup } = require("../services/walletTopup");
const {
  normalisePurpose,
  recordOrder,
  markOrderPaid,
  markOrderFinalized,
  recordPaymentException,
  autoResolveProcessingErrors,
} = require("../services/paymentOrders");
const { computeVehicleCount } = require("../services/fare");
const { sendWhatsAppMessage } = require("../services/whatsapp");
const router = express.Router();

// Support-assisted bookings (routes/support.js) never create a ride at
// request time -- they only lock in a fare quote and, once a payment link
// is generated, a payment_reference. The ride itself is created HERE, only
// once Paystack's own webhook signature (the one source of truth this
// whole file exists to trust) confirms the charge actually succeeded. This
// mirrors the card branch of POST /api/rides (routes/rides.js) field for
// field -- same columns, same defaults -- except payment_status is set to
// 'paid' directly (that branch relies on a later client call or this same
// webhook to flip it; here the payment is already confirmed before this
// runs at all) and fleet-escort/lucky-ride side effects are deliberately
// NOT run (see the payment-link route's comment in routes/support.js for
// why fleet_size > 0 never reaches this function to begin with).
async function createRideFromAssistedBooking(dbClient, booking, reference, paidAmountNaira) {
  const req = booking.booking_request || {};
  const vehicleCount = computeVehicleCount(Number(req.passengerCount) || 1, req.vehicleType);

  const inserted = await dbClient.query(
    `INSERT INTO rides (
       rider_id, pickup_address, stops, flight_number, vehicle_type, fare_naira, payment_reference,
       booking_type, duration_days, agreed_cancellation_policy, distance_km, duration_min,
       security_escort, fleet_size, payment_status, payment_method, pay_at_pickup,
       emergency_contact_name, emergency_contact_phone, dash_cam_consent,
       pickup_lat, pickup_lng, destination_lat, destination_lng, scheduled_pickup_at,
       linked_ride_id, preferred_driver_id, preferred_vehicle_snapshot, original_flight_scheduled_at,
       adults, children, vehicle_count, included_hours_per_day,
       quoted_usd_amount, quoted_ngn_per_usd, promo_code, promo_discount_naira, partner_venue_id
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7,
       $8, $9, true, $10, $11,
       $12, $13, 'paid', 'card', false,
       $14, $15, $16,
       $17, $18, $19, $20, $21,
       $22, $23, $24, $25,
       $26, $27, $28, $29,
       $30, $31, $32, $33, $34
     ) RETURNING *`,
    [
      booking.rider_id, req.pickupAddress, JSON.stringify(req.destinationAddress ? [req.destinationAddress] : []),
      req.flightNumber || null, req.vehicleType, paidAmountNaira, reference,
      req.bookingType, req.durationDays || 1, null, null,
      !!req.securityEscort, Number(req.fleetSize) || 0,
      null, null, false,
      null, null, null, null, req.scheduledPickupAt || null,
      null, null, null, null,
      Number(req.adults) || 1, Number(req.children) || 0, vehicleCount, null,
      Number(booking.quoted_usd_amount), Number(booking.quoted_ngn_per_usd), null, null, null,
    ]
  );
  return inserted.rows[0];
}

const PAYSTACK_BASE = "https://api.paystack.co";

function paystackHeaders() {
  return { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` };
}

// Shared by GET /verify/:reference below and PATCH /api/rides/:id/payment
// (routes/rides.js) — the one place that actually calls Paystack to find
// out whether a transaction really succeeded. Never trust a client's word
// for this; always ask Paystack.
async function verifyPaystackTransaction(reference) {
  if (!isValidPaystackReference(reference)) {
    throw Object.assign(new Error("Invalid payment reference."), { status: 400, invalidReference: true });
  }
  const response = await axios.get(`${PAYSTACK_BASE}/transaction/verify/${encodeURIComponent(reference)}`, {
    headers: paystackHeaders(),
    // Without a timeout a stalled Paystack call holds the request open forever.
    timeout: 10000,
  });
  const data = response.data.data;
  // Everything downstream credits "amount / 100" as naira, so a payment in
  // any other currency must not count as a success.
  const inNaira = data.currency === "NGN";
  return {
    success: data.status === "success" && inNaira,
    status: inNaira ? data.status : "wrong_currency",
    amountNaira: data.amount / 100,
    currency: data.currency,
    paidAt: data.paid_at,
  };
}

// Shared by POST /initialize below and the support-assisted-booking
// payment-link route (routes/support.js) -- the one place that actually
// calls Paystack to start a transaction, same reasoning as
// verifyPaystackTransaction above being the one place that checks one.
// Throws on a bad amount or a missing secret key; callers translate that
// into their own error response shape.
async function initializePaystackTransaction({ email, amountNaira }) {
  if (!email || !Number.isFinite(amountNaira) || amountNaira <= 0) {
    throw new Error("email and a positive amountNaira are required");
  }
  if (!process.env.PAYSTACK_SECRET_KEY || process.env.PAYSTACK_SECRET_KEY.includes("replace_me")) {
    throw new Error("PAYSTACK_SECRET_KEY is not configured on the server");
  }

  const response = await axios.post(
    `${PAYSTACK_BASE}/transaction/initialize`,
    {
      email,
      amount: Math.round(amountNaira * 100), // Paystack expects kobo
      // Every credit and fare check downstream treats amount / 100 as naira, so
      // say so explicitly instead of relying on the account default.
      currency: "NGN",
      callback_url: process.env.PAYSTACK_CALLBACK_URL,
    },
    { headers: paystackHeaders(), timeout: 10000 }
  );

  const { authorization_url, access_code, reference } = response.data.data;
  return { authorizationUrl: authorization_url, accessCode: access_code, reference };
}

// These two routes are public (the shipped rider app calls them without a
// token, so requiring auth would break installed apps). They cannot credit
// money, but /initialize creates Paystack transactions and /verify makes an
// outbound Paystack call per request, so cap both per IP. Limits are high
// enough for shared carrier NAT addresses and tunable through env vars.
function paymentLimiter(limit, message) {
  return rateLimit({
    windowMs: 10 * 60 * 1000,
    limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ error: message }),
  });
}
const initializeLimiter = paymentLimiter(
  Number(process.env.PAYMENT_INIT_RATE_LIMIT) || 30,
  "Too many payment attempts. Please wait a few minutes and try again."
);
const verifyLimiter = paymentLimiter(
  Number(process.env.PAYMENT_VERIFY_RATE_LIMIT) || 120,
  "Too many payment checks. Please wait a few minutes and try again."
);

// Off by default because app builds released before the token change send no
// Authorization header to these routes. Set PAYMENT_ROUTES_REQUIRE_AUTH=true
// once those builds are retired. Read per request so flipping it needs no code.
function maybeRequireAuth(req, res, next) {
  if (process.env.PAYMENT_ROUTES_REQUIRE_AUTH === "true") return requireAuth(req, res, next);
  next();
}

// Reads the rider's login if the request carries one, WITHOUT refusing the
// request when it does not. This is phase 2 of the token plan: builds already
// in the stores send no token to /initialize, so it cannot be required yet
// (see PAYMENT_ROUTES_REQUIRE_AUTH above for phase 3). A valid token lets us
// remember who is paying and for what, so the webhook can finish the job if
// the app is closed. A missing, expired or bad token just means "anonymous".
// Reuses requireAuth so a deleted account or revoked session counts as
// anonymous here exactly as it would be refused everywhere else.
async function softAuth(req) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return null;
  let allowed = false;
  const fakeRes = {
    status() { return this; },
    json() { return this; },
  };
  try {
    await requireAuth(req, fakeRes, () => { allowed = true; });
  } catch (e) {
    return null;
  }
  return allowed ? req.user : null;
}

// POST /api/payments/initialize
// body: { email, amountNaira, purpose?, booking? }
// Call this from the app right before showing checkout. Returns an
// authorization_url to open in a browser/webview, and a reference to verify later.
//
// purpose ('ride' | 'wallet_topup') and booking (the ride the rider is paying
// for, same shape as POST /api/rides) are new and optional. Builds that do not
// send them behave exactly as before. With a valid login token they are stored
// as a pending order so the Paystack webhook can finish the payment even if the
// app never comes back from checkout. Without a token they are ignored: a
// payment is never tied to an account on the say-so of an anonymous request.
router.post("/initialize", initializeLimiter, maybeRequireAuth, async (req, res) => {
  const { email, amountNaira, purpose, booking } = req.body;

  if (!email || !amountNaira) {
    return res.status(400).json({ error: "email and amountNaira are required" });
  }
  // amountNaira previously only had a truthiness check, so 0, a negative
  // number, or NaN all passed it — Paystack itself rejects a bogus
  // transaction_initialize amount, and nothing is credited from this route
  // alone (see routes/payments.js's /verify and the webhook below, which
  // re-check Paystack's own confirmed amount rather than trusting the
  // client), so this was never a path to actually crediting a wallet. It's
  // still worth rejecting here rather than letting a malformed request
  // reach Paystack's API at all.
  if (!Number.isFinite(amountNaira) || amountNaira <= 0) {
    return res.status(400).json({ error: "amountNaira must be a positive number" });
  }
  if (!process.env.PAYSTACK_SECRET_KEY || process.env.PAYSTACK_SECRET_KEY.includes("replace_me")) {
    return res.status(500).json({ error: "PAYSTACK_SECRET_KEY is not configured on the server" });
  }

  const user = await softAuth(req);
  if (!user) {
    // Phase 2 of the token plan: count the calls that still come without a
    // login so we know when it is safe to enforce one (phase 3).
    console.warn(`[payments] initialize without a valid login token purpose=${normalisePurpose(purpose)}`);
  }

  try {
    const result = await initializePaystackTransaction({ email, amountNaira });
    // Remembering the order must never stop a payment that Paystack has
    // already started: the old flow (verify, then create the ride) does not
    // depend on it.
    try {
      await recordOrder(pool, {
        reference: result.reference,
        userId: user ? user.id : null,
        email,
        purpose,
        amountNaira,
        payload: booking,
      });
    } catch (orderErr) {
      console.error("Could not record the pending payment order:", orderErr.message);
    }
    res.json(result);
  } catch (err) {
    console.error("Paystack initialize failed:", err.response?.data || err.message);
    res.status(502).json({ error: "Could not start payment. Please try again." });
  }
});

// GET /api/payments/verify/:reference
// Call this after the checkout browser closes, to confirm the payment
// actually succeeded before marking a ride as paid. Never trust the
// frontend's word alone that a payment succeeded.
router.get("/verify/:reference", verifyLimiter, maybeRequireAuth, async (req, res) => {
  try {
    const result = await verifyPaystackTransaction(req.params.reference);
    res.json(result);
  } catch (err) {
    if (err.invalidReference) return res.status(400).json({ error: "Invalid payment reference." });
    console.error("Paystack verify failed:", err.response?.data || err.message);
    res.status(502).json({ error: "Could not verify payment." });
  }
});

// ── Paystack webhook ──
//
// The webhook is the one confirmation Paystack sends even when the rider's app
// is closed mid-checkout, so it is where a payment must end up somewhere safe.
// Rules it follows:
//
//   * A payment that cannot be matched to anything for a business reason (wrong
//     currency, wrong amount, reference already spent, a booking that no longer
//     validates) is written to payment_exceptions for a person to refund or
//     resolve, and answered 200. Retrying would only repeat the same answer.
//
//   * A failure that might pass on its own (database down, a bug, Paystack
//     unreachable while re-verifying) answers 5xx. Paystack then retries the
//     delivery, so a payment is not silently dropped just because the database
//     blinked. The old code logged these and answered 200, which told Paystack
//     everything was fine and ended the retries.
//
//   * Every step is safe to run twice. Paystack redelivers, and the app's own
//     verify-then-create-ride call can arrive at the same moment.

const KOBO = 100;

async function handleExistingRide(ride, { reference, amountKobo }) {
  if (ride.payment_status === "paid") {
    // Already marked paid, for example by a previous delivery.
    await markOrderFinalized(pool, reference, ride.id);
    return "already_paid";
  }
  // Check the amount BEFORE writing anything: an underpaid or wrong-amount
  // transaction must never flip a ride to paid.
  const expectedKobo = Math.round(Number(ride.fare_naira) * KOBO);
  if (amountKobo !== expectedKobo) {
    await recordPaymentException(pool, {
      reference,
      reason: "amount_mismatch",
      purpose: "ride",
      userId: ride.rider_id,
      amountNaira: amountKobo / KOBO,
      details: { rideId: ride.id, expectedKobo, paidKobo: amountKobo },
    });
    return "amount_mismatch";
  }
  // Claim the reference in the SAME transaction as the UPDATE, like the other
  // card-payment call sites, so a charge this webhook settles cannot be
  // replayed on a tip, overage charge or wallet top-up.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const claimed = await claimPaymentReference(client, reference, "ride_payment", ride.id);
    if (!claimed) {
      await client.query("ROLLBACK");
      const owner = await pool.query("SELECT used_for, ride_id FROM used_payment_references WHERE reference = $1", [reference]);
      if (owner.rows[0] && owner.rows[0].used_for === "ride_payment" && owner.rows[0].ride_id === ride.id) {
        // The app's own call got there first. Nothing left to do.
        await markOrderFinalized(pool, reference, ride.id);
        return "already_paid";
      }
      await recordPaymentException(pool, {
        reference,
        reason: "reference_already_used",
        purpose: "ride",
        userId: ride.rider_id,
        amountNaira: amountKobo / KOBO,
        details: { rideId: ride.id, claimedBy: owner.rows[0] || null },
      });
      return "reference_already_used";
    }
    await client.query(
      `UPDATE rides SET payment_status = 'paid', updated_at = now() WHERE id = $1 AND payment_status != 'paid'`,
      [ride.id]
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  await markOrderFinalized(pool, reference, ride.id);
  console.log(`Payment confirmed via webhook: ride #${ride.id}, ref ${reference}`);
  return "paid";
}

// A support-assisted booking's payment link (routes/support.js). Same
// amount-then-claim-then-write sequence as a ride, against a different table.
async function handleAssistedBooking(booking, { reference, amountKobo }) {
  if (booking.ride_id) {
    // Already turned into a ride by a previous delivery.
    await markOrderFinalized(pool, reference, booking.ride_id);
    return "already_paid";
  }
  const expectedKobo = Math.round(Number(booking.fare_naira) * KOBO);
  if (amountKobo !== expectedKobo) {
    await recordPaymentException(pool, {
      reference,
      reason: "amount_mismatch",
      purpose: "support_assisted_booking",
      userId: booking.rider_id,
      amountNaira: amountKobo / KOBO,
      details: { assistedBookingId: booking.id, expectedKobo, paidKobo: amountKobo },
    });
    return "amount_mismatch";
  }
  const client = await pool.connect();
  let newRide;
  try {
    await client.query("BEGIN");
    // used_payment_references.ride_id is a real FK to rides(id) and no ride
    // exists yet when the reference must be claimed (claiming first closes the
    // race against a second delivery), so this claims with ride_id null and
    // backfills it below.
    const claimed = await claimPaymentReference(client, reference, "support_assisted_booking", null);
    if (!claimed) {
      await client.query("ROLLBACK");
      await recordPaymentException(pool, {
        reference,
        reason: "reference_already_used",
        purpose: "support_assisted_booking",
        userId: booking.rider_id,
        amountNaira: amountKobo / KOBO,
        details: { assistedBookingId: booking.id },
      });
      return "reference_already_used";
    }
    newRide = await createRideFromAssistedBooking(client, booking, reference, amountKobo / KOBO);
    await client.query(
      `UPDATE support_assisted_bookings SET ride_id = $1, payment_status = 'paid', updated_at = now() WHERE id = $2`,
      [newRide.id, booking.id]
    );
    await client.query(`UPDATE used_payment_references SET ride_id = $1 WHERE reference = $2`, [newRide.id, reference]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  await markOrderFinalized(pool, reference, newRide.id);
  console.log(`Assisted booking #${booking.id} paid via webhook, ref ${reference} -- created ride #${newRide.id}.`);

  const rider = await pool.query("SELECT phone, name FROM users WHERE id = $1", [booking.rider_id]);
  if (rider.rows[0]?.phone) {
    sendWhatsAppMessage(
      rider.rows[0].phone,
      `Thanks ${rider.rows[0].name || ""}! Your payment went through and your RideArrivo ride #${newRide.id} is booked.`
    ).catch(() => {});
  }
  return "paid";
}

// Finishes a ride booking from the pending order the rider's app left at
// initialize. It runs the SAME handler as POST /api/rides (fare recomputed by
// the server, Paystack asked again, reference claimed in the same transaction
// as the ride), so a webhook-made ride can never be cheaper or looser than one
// the app made itself. If the app's own call lands too, the handler finds the
// reference already spent on this rider's ride and returns that ride.
async function createRideFromOrder(order, { reference, amountKobo }) {
  // Lazy: routes/rides.js requires this file for verifyPaystackTransaction.
  const { createRideHandler } = require("./rides");
  const captured = { status: 200, body: null };
  const fakeRes = {
    status(code) { captured.status = code; return this; },
    json(body) { captured.body = body; return this; },
  };
  const fakeReq = {
    user: { id: order.user_id, role: "rider" },
    headers: {},
    query: {},
    params: {},
    body: { ...order.payload, paymentMethod: "card", paymentReference: reference },
  };
  await createRideHandler(fakeReq, fakeRes);

  if (captured.status === 200 || captured.status === 201) {
    const rideId = captured.body && captured.body.ride && captured.body.ride.id;
    await markOrderFinalized(pool, reference, rideId || null);
    console.log(`Ride #${rideId} created from the pending order via webhook, ref ${reference}`);
    return "ride_created";
  }
  if (captured.status >= 500) {
    // Paystack unreachable, database trouble: let Paystack deliver it again.
    throw new Error(`Creating the ride from the pending order failed with ${captured.status}`);
  }
  // The booking no longer validates (the pickup time passed, the fare changed,
  // the rider was underpaid...). The money is real and the ride is not, so a
  // person has to decide: refund it, or book it by hand.
  await recordPaymentException(pool, {
    reference,
    reason: "ride_not_created",
    purpose: "ride",
    userId: order.user_id,
    amountNaira: amountKobo / KOBO,
    details: { status: captured.status, error: captured.body && captured.body.error },
  });
  return "ride_not_created";
}

// A payment with no ride and no assisted booking behind it. Either the app
// told us what it was for (a pending order from a signed-in rider), or it did
// not (older builds, or the website's own checkout popup), in which case the
// app is expected to come back and finish it, and the sweep in
// services/scheduler.js flags it if nobody ever does.
async function handleOrder(reference, { amountKobo, email }) {
  const order = await markOrderPaid(pool, reference, { amountNaira: amountKobo / KOBO, email });
  if (order.status === "finalized") return "already_finalized";

  const orderKobo = order.amount_naira != null ? Math.round(Number(order.amount_naira) * KOBO) : null;
  const known = order.user_id && (order.purpose === "wallet_topup" || (order.purpose === "ride" && order.payload));
  if (!known) return "awaiting_client";

  // What Paystack took must equal what this order asked for.
  if (orderKobo != null && orderKobo !== amountKobo) {
    await recordPaymentException(pool, {
      reference,
      reason: "amount_mismatch",
      purpose: order.purpose,
      userId: order.user_id,
      amountNaira: amountKobo / KOBO,
      details: { orderId: order.id, expectedKobo: orderKobo, paidKobo: amountKobo },
    });
    return "amount_mismatch";
  }

  if (order.purpose === "wallet_topup") {
    const client = await pool.connect();
    let credit;
    try {
      await client.query("BEGIN");
      credit = await creditWalletTopup(client, { userId: order.user_id, reference, amountNaira: amountKobo / KOBO });
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    if (credit.credited || credit.reason === "already_credited") {
      await markOrderFinalized(pool, reference);
      return credit.credited ? "wallet_credited" : "already_credited";
    }
    await recordPaymentException(pool, {
      reference,
      reason: "reference_already_used",
      purpose: "wallet_topup",
      userId: order.user_id,
      amountNaira: amountKobo / KOBO,
      details: { orderId: order.id },
    });
    return "reference_already_used";
  }

  return createRideFromOrder(order, { reference, amountKobo });
}

async function handleChargeSuccess(data) {
  const { reference, amount, currency, customer } = data;
  if (typeof reference !== "string" || !reference) {
    console.error("Webhook charge.success carried no reference; nothing to match it to.");
    return "no_reference";
  }
  const amountKobo = Number(amount);
  const email = customer && customer.email ? customer.email : null;

  if (!isValidPaystackReference(reference)) {
    await recordPaymentException(pool, {
      reference: reference.slice(0, 200),
      reason: "invalid_reference",
      amountNaira: Number.isFinite(amountKobo) ? amountKobo / KOBO : null,
      details: { currency },
    });
    return "invalid_reference";
  }
  if (!Number.isFinite(amountKobo) || amountKobo <= 0) {
    await recordPaymentException(pool, { reference, reason: "invalid_amount", details: { amount, currency } });
    return "invalid_amount";
  }
  // Everything downstream reads amount / 100 as naira, so a payment in another
  // currency must never credit or pay for anything. It is recorded so someone
  // can refund it.
  if (currency !== "NGN") {
    await recordPaymentException(pool, {
      reference,
      reason: "wrong_currency",
      amountNaira: amountKobo / KOBO,
      details: { currency, email },
    });
    return "wrong_currency";
  }

  const existing = await pool.query(
    "SELECT id, rider_id, fare_naira, payment_status FROM rides WHERE payment_reference = $1",
    [reference]
  );
  if (existing.rows[0]) return handleExistingRide(existing.rows[0], { reference, amountKobo });

  const assisted = await pool.query(`SELECT * FROM support_assisted_bookings WHERE payment_reference = $1`, [reference]);
  if (assisted.rows[0]) return handleAssistedBooking(assisted.rows[0], { reference, amountKobo });

  return handleOrder(reference, { amountKobo, email });
}

// POST /api/payments/webhook
// Configure this URL in the Paystack dashboard (Settings > API Keys & Webhooks).
// This is the RELIABLE way to know a payment succeeded — it fires even if
// the user closes the app mid-checkout. Always verify the signature.
router.post(
  "/webhook",
  express.raw({ type: "application/json" }), // need the raw body to check the signature
  async (req, res) => {
    const signature = req.headers["x-paystack-signature"];
    // With no key configured the HMAC below would be computed over an empty
    // key, which anyone can reproduce, so every webhook would pass. Refuse
    // them all instead.
    if (!process.env.PAYSTACK_SECRET_KEY) {
      console.error("Paystack webhook ignored: PAYSTACK_SECRET_KEY is not set.");
      return res.sendStatus(503);
    }
    const expected = crypto
      .createHmac("sha512", process.env.PAYSTACK_SECRET_KEY)
      .update(req.body)
      .digest("hex");

    // timingSafeEqual over a plain !== comparison — this is the one truly
    // trusted payment-confirmation path (see comment above), so it's worth
    // closing even a theoretical timing side-channel on the HMAC check.
    // Requires equal-length buffers, hence the length check first (a length
    // mismatch already means "not equal" without needing the safe compare).
    const signatureBuf = Buffer.from(signature || "", "utf8");
    const expectedBuf = Buffer.from(expected, "utf8");
    const signatureValid =
      signatureBuf.length === expectedBuf.length && crypto.timingSafeEqual(signatureBuf, expectedBuf);

    if (!signatureValid) {
      console.warn("Webhook signature mismatch — ignoring request");
      return res.sendStatus(401);
    }

    let event;
    try {
      event = JSON.parse(req.body.toString());
    } catch (e) {
      // Signed but unreadable: retrying the same bytes cannot help.
      console.error("Webhook body was signed but is not valid JSON.");
      return res.sendStatus(400);
    }

    // Other event types (transfers, refunds...) are acknowledged and ignored.
    if (event.event !== "charge.success") return res.sendStatus(200);

    const data = event.data || {};
    try {
      const outcome = await handleChargeSuccess(data);
      if (typeof data.reference === "string") {
        await autoResolveProcessingErrors(pool, data.reference);
      }
      console.log(`Webhook charge.success ref=${data.reference} outcome=${outcome}`);
      return res.sendStatus(200);
    } catch (err) {
      console.error(`Webhook processing failed for ref ${data.reference}:`, err.message);
      // Best effort: leave a trail for a person even if this turns out to be a
      // database outage, then ask Paystack to deliver it again.
      if (typeof data.reference === "string") {
        await recordPaymentException(pool, {
          reference: data.reference.slice(0, 200),
          reason: "processing_error",
          amountNaira: Number.isFinite(Number(data.amount)) ? Number(data.amount) / KOBO : null,
          details: { message: err.message },
        }).catch((e) => console.error("Could not record the payment exception either:", e.message));
      }
      return res.sendStatus(500);
    }
  }
);

module.exports = router;
module.exports.verifyPaystackTransaction = verifyPaystackTransaction;
module.exports.initializePaystackTransaction = initializePaystackTransaction;
