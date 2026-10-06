const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const { pool } = require("../db/db");
const { claimPaymentReference } = require("../services/paymentReferences");
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
  const response = await axios.get(`${PAYSTACK_BASE}/transaction/verify/${reference}`, {
    headers: paystackHeaders(),
  });
  const data = response.data.data;
  return {
    success: data.status === "success",
    status: data.status,
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
      callback_url: process.env.PAYSTACK_CALLBACK_URL,
    },
    { headers: paystackHeaders() }
  );

  const { authorization_url, access_code, reference } = response.data.data;
  return { authorizationUrl: authorization_url, accessCode: access_code, reference };
}

// POST /api/payments/initialize
// body: { email, amountNaira, reference? }
// Call this from the app right before showing checkout. Returns an
// authorization_url to open in a browser/webview, and a reference to verify later.
router.post("/initialize", async (req, res) => {
  const { email, amountNaira } = req.body;

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

  try {
    const result = await initializePaystackTransaction({ email, amountNaira });
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
router.get("/verify/:reference", async (req, res) => {
  try {
    const result = await verifyPaystackTransaction(req.params.reference);
    res.json(result);
  } catch (err) {
    console.error("Paystack verify failed:", err.response?.data || err.message);
    res.status(502).json({ error: "Could not verify payment." });
  }
});

// POST /api/payments/webhook
// Configure this URL in the Paystack dashboard (Settings > API Keys & Webhooks).
// This is the RELIABLE way to know a payment succeeded — it fires even if
// the user closes the app mid-checkout. Always verify the signature.
router.post(
  "/webhook",
  express.raw({ type: "application/json" }), // need the raw body to check the signature
  async (req, res) => {
    const signature = req.headers["x-paystack-signature"];
    const expected = crypto
      .createHmac("sha512", process.env.PAYSTACK_SECRET_KEY || "")
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

    const event = JSON.parse(req.body.toString());
    if (event.event === "charge.success") {
      const { reference, amount, customer } = event.data;

      // This only UPDATES an existing ride — it can't create one from
      // scratch, since the app currently creates the ride row itself only
      // after the client-side verify step succeeds (see CheckoutScreen's
      // verifyAndCreateRide). So this webhook is a backstop for a ride that
      // already exists with this payment_reference (e.g. the client-side
      // verify call failed/timed out after the ride was created but before
      // its status got updated) — not yet a full replacement for that flow.
      // If a rider closes the app before ever returning from Paystack
      // checkout, no ride is created either way, webhook or not — fixing
      // that needs rides to be created as "pending" before redirecting to
      // Paystack, which is a bigger flow change than this webhook alone.
      try {
        // Check the amount BEFORE writing anything — an underpaid or
        // wrong-amount transaction must never flip a ride to "paid", not
        // just get logged after the fact. SELECT first (no write yet).
        const existing = await pool.query(
          "SELECT id, fare_naira, payment_status FROM rides WHERE payment_reference = $1",
          [reference]
        );
        const ride = existing.rows[0];
        if (!ride) {
          // Not a normal-flow ride payment -- check whether this reference
          // belongs to a support-assisted booking's payment link instead
          // (routes/support.js's POST /assisted-bookings/:id/payment-link).
          // Same "check the amount before writing anything" rule as the
          // ride branch below: this is a real second entity in a different
          // table, not a variant of the same check, so it gets its own
          // full amount-then-claim-then-write sequence.
          const assistedExisting = await pool.query(
            `SELECT * FROM support_assisted_bookings WHERE payment_reference = $1`,
            [reference]
          );
          const assistedBooking = assistedExisting.rows[0];
          if (!assistedBooking) {
            console.log(`Payment confirmed via webhook for ref ${reference}, but no matching ride or assisted booking found yet.`);
          } else if (assistedBooking.ride_id) {
            // Already turned into a ride (e.g. a previous webhook delivery) --
            // Paystack retries webhooks, so this must be a safe no-op.
          } else {
            const expectedKobo = Math.round(Number(assistedBooking.fare_naira) * 100);
            if (Number(amount) !== expectedKobo) {
              console.error(
                `Webhook amount mismatch for assisted booking #${assistedBooking.id}: paid ${amount} kobo, expected ${expectedKobo} kobo -- NOT creating a ride.`
              );
            } else {
              const assistedClient = await pool.connect();
              try {
                await assistedClient.query("BEGIN");
                // used_payment_references.ride_id is a real FK to rides(id), and
                // no ride exists yet at the moment this reference needs to be
                // claimed (claiming first, before creating anything, is what
                // closes the race window against a second webhook delivery
                // hitting this same branch concurrently) -- so this claims
                // with ride_id left null, then backfills it once the ride
                // actually exists below. The column is there for audit
                // trail/debugging, not enforced elsewhere, so a brief null
                // window on it is harmless.
                const claimed = await claimPaymentReference(assistedClient, reference, "support_assisted_booking", null);
                if (!claimed) {
                  await assistedClient.query("ROLLBACK");
                  console.error(
                    `Webhook: payment reference ${reference} for assisted booking #${assistedBooking.id} was already claimed elsewhere -- not creating a ride.`
                  );
                } else {
                  const newRide = await createRideFromAssistedBooking(assistedClient, assistedBooking, reference, Number(amount) / 100);
                  await assistedClient.query(
                    `UPDATE support_assisted_bookings SET ride_id = $1, payment_status = 'paid', updated_at = now() WHERE id = $2`,
                    [newRide.id, assistedBooking.id]
                  );
                  await assistedClient.query(
                    `UPDATE used_payment_references SET ride_id = $1 WHERE reference = $2`,
                    [newRide.id, reference]
                  );
                  await assistedClient.query("COMMIT");
                  console.log(`Assisted booking #${assistedBooking.id} paid via webhook, ref ${reference} -- created ride #${newRide.id}.`);

                  const rider = await pool.query("SELECT phone, name FROM users WHERE id = $1", [assistedBooking.rider_id]);
                  if (rider.rows[0]?.phone) {
                    sendWhatsAppMessage(
                      rider.rows[0].phone,
                      `Thanks ${rider.rows[0].name || ""}! Your payment went through and your RideArrivo ride #${newRide.id} is booked.`
                    ).catch(() => {});
                  }
                }
              } catch (assistedErr) {
                await assistedClient.query("ROLLBACK");
                console.error("Assisted-booking webhook ride creation failed:", assistedErr.message);
              } finally {
                assistedClient.release();
              }
            }
          }
        } else if (ride.payment_status === "paid") {
          // Already marked paid (e.g. by a previous webhook delivery) — Paystack
          // retries webhooks, so this must be a safe no-op, not an error.
        } else {
          const expectedKobo = Math.round(Number(ride.fare_naira) * 100);
          if (Number(amount) !== expectedKobo) {
            console.error(
              `Webhook amount mismatch for ride #${ride.id}: paid ${amount} kobo, expected ${expectedKobo} kobo — NOT marking paid.`
            );
          } else {
            // Claim the reference in the SAME transaction as the UPDATE, exactly
            // like the other four card-payment call sites (PATCH :id/payment,
            // POST :id/tip, POST :id/overage-charge, wallet topup verify) — this
            // webhook was the one path that could mark a ride paid WITHOUT ever
            // recording the reference as spent, meaning a genuinely-successful
            // charge (if this webhook is what settles it, e.g. the client-side
            // verify call never lands) could then be replayed on a tip, overage
            // charge, or wallet top-up as if it were a brand-new payment.
            const webhookClient = await pool.connect();
            try {
              await webhookClient.query("BEGIN");
              const claimed = await claimPaymentReference(webhookClient, reference, "ride_payment", ride.id);
              if (!claimed) {
                await webhookClient.query("ROLLBACK");
                console.error(
                  `Webhook: payment reference ${reference} for ride #${ride.id} was already claimed elsewhere — not marking paid.`
                );
              } else {
                await webhookClient.query(
                  `UPDATE rides SET payment_status = 'paid', updated_at = now()
                   WHERE id = $1 AND payment_status != 'paid'`,
                  [ride.id]
                );
                await webhookClient.query("COMMIT");
                console.log(`Payment confirmed via webhook: ride #${ride.id}, ref ${reference} - NGN ${amount / 100} - ${customer.email}`);
              }
            } catch (claimErr) {
              await webhookClient.query("ROLLBACK");
              throw claimErr;
            } finally {
              webhookClient.release();
            }
          }
        }
      } catch (e) {
        console.error("Webhook DB update failed:", e.message);
      }
    }

    res.sendStatus(200);
  }
);

module.exports = router;
module.exports.verifyPaystackTransaction = verifyPaystackTransaction;
module.exports.initializePaystackTransaction = initializePaystackTransaction;
