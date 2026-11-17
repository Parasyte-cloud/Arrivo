const express = require("express");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const rateLimit = require("express-rate-limit");
const { pool } = require("../db/db");
const { computeFare } = require("../services/fare");
const { getNgnPerUsd } = require("../services/fx");
const { initializePaystackTransaction } = require("./payments");
const { sendWhatsAppMessage } = require("../services/whatsapp");
const { sendInvoiceEmail } = require("../services/email");
const { validateTrip, validateSubmission, BOOKING_TYPES } = require("../services/easybookRequest");

const router = express.Router();

// EasyBook: the open assisted booking flow behind easybookings.ridearrivo.com.
//
// Why it is open (no sign-in): the earlier version made the customer sign in
// first, and people who could not get through that wall simply did not book.
// Dropping it is safe because of how the money flows, not because of who is
// asking:
//   1. Nothing here creates a ride. A request is only a pre-payment row.
//   2. The ride is created only by the verified Paystack webhook
//      (routes/payments.js handleAssistedBooking), after the exact amount has
//      been confirmed paid.
//   3. No session or token is ever issued, so typing someone else's email gets
//      you nothing except an invoice that only that person can pay, in their
//      own inbox. The pay link is sent to the email, never trusted from a form.
//   4. Per-IP and per-email limits stop it being used to spam anyone or to burn
//      Paystack and WhatsApp credit.
//
// ArrivoExpress is deliberately not offered here: it is its own product with
// its own checkout.

const ipLimiter = (limit, message) =>
  rateLimit({
    windowMs: 60 * 60 * 1000,
    limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ error: message }),
  });

// Quotes call Google Distance Matrix, which costs money per call.
const quoteLimiter = ipLimiter(
  Number(process.env.EASYBOOK_QUOTE_RATE_LIMIT) || 60,
  "Too many price checks from this connection. Please try again in a little while."
);
// A support desk may legitimately book for many customers from one office IP,
// so this is looser than the old 5 an hour, and the per-email cap below does
// the real anti-spam work.
const submitLimiter = ipLimiter(
  Number(process.env.EASYBOOK_SUBMIT_RATE_LIMIT) || 30,
  "Too many requests from this connection. Please try again in a little while, or message us on WhatsApp."
);
const invoiceLimiter = ipLimiter(120, "Too many invoice lookups. Please try again in a little while.");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN_RE = /^[0-9a-f]{48}$/;
const MAX_PENDING_PER_EMAIL_PER_HOUR = Number(process.env.EASYBOOK_MAX_PER_EMAIL_PER_HOUR) || 4;
const PUBLIC_URL = (process.env.EASYBOOK_PUBLIC_URL || "https://easybookings.ridearrivo.com").replace(/\/$/, "");

function invoiceUrlFor(token) {
  return `${PUBLIC_URL}/?invoice=${token}`;
}

async function priceTrip(trip) {
  const ngnPerUsd = await getNgnPerUsd();
  const fareNaira = await computeFare({
    bookingType: trip.bookingType,
    pickupAddress: trip.pickupAddress,
    destinationAddress: trip.destinationAddress,
    vehicleType: trip.vehicleType,
    securityEscort: trip.securityEscort,
    fleetSize: 0,
    luxury: trip.luxury,
    ngnPerUsd,
    durationDays: trip.durationDays,
    passengerCount: trip.passengerCount,
  });
  return { fareNaira, ngnPerUsd };
}

// Finds the rider for this email, or creates one. Never issues a token. A
// staff, driver or owner email is refused so a stranger cannot attach a
// booking to an internal account.
async function findOrCreateRider({ name, email, phone }) {
  const found = await pool.query("SELECT id, name, email, phone, role FROM users WHERE email = $1", [email]);
  if (found.rows[0]) {
    if (found.rows[0].role !== "rider") {
      return { error: "That email belongs to a team account. Please use the passenger's own email address." };
    }
    return { rider: found.rows[0], created: false };
  }
  const passwordHash = bcrypt.hashSync(crypto.randomBytes(24).toString("hex"), 10);
  const inserted = await pool.query(
    `INSERT INTO users (name, email, phone, whatsapp_number, password_hash, role, agreed_to_terms)
     VALUES ($1, $2, $3, $3, $4, 'rider', true)
     ON CONFLICT (email) DO NOTHING
     RETURNING id, name, email, phone, role`,
    [name, email, phone, passwordHash]
  );
  if (inserted.rows[0]) {
    try {
      require("../services/notifyPlatform").emitSignup(inserted.rows[0], { emailVerified: false });
    } catch (_) {
      // Analytics only. Never block a booking on it.
    }
    return { rider: inserted.rows[0], created: true };
  }
  // Lost a race with another request for the same new email: read it back.
  const again = await pool.query("SELECT id, name, email, phone, role FROM users WHERE email = $1", [email]);
  return { rider: again.rows[0], created: false };
}

function publicInvoice(row) {
  const r = row.booking_request || {};
  const paid = row.payment_status === "paid";
  return {
    invoiceNumber: row.invoice_number,
    status: paid ? "paid" : row.payment_status,
    fareNaira: Number(row.fare_naira),
    createdAt: row.created_at,
    paidAt: row.paid_at || null,
    rideId: paid ? row.ride_id : null,
    passengerName: row.rider_name || null,
    // The pay link is only handed back while it can still be used.
    payUrl: paid || row.payment_status !== "pending" ? null : row.payment_link_url,
    trip: {
      bookingType: r.bookingType,
      vehicleType: r.vehicleType,
      pickupAddress: r.pickupAddress,
      destinationAddress: r.destinationAddress || null,
      flightNumber: r.flightNumber || null,
      flightDate: r.flightDate || null,
      scheduledPickupAt: r.scheduledPickupAt || null,
      durationDays: r.durationDays || 1,
      passengers: (Number(r.adults) || 1) + (Number(r.children) || 0),
      securityEscort: !!r.securityEscort,
      luxury: !!r.luxury,
      notes: r.notes || null,
    },
  };
}

// GET /api/public/easybook/options
// What this page can book. Kept server side so the page and the rules cannot
// drift: the page renders whatever this says is allowed.
router.get("/easybook/options", (req, res) => {
  res.json({ bookingTypes: BOOKING_TYPES, vehicleTypes: ["sedan", "suv", "truck", "pickup"], arrivoExpress: false });
});

// POST /api/public/easybook/quote
// Price check only. Creates nothing. Same validation as a real submission, so
// the price shown is always one the submit step will accept.
router.post("/easybook/quote", quoteLimiter, async (req, res) => {
  const trip = validateTrip(req.body);
  if (!trip.ok) return res.status(trip.status).json(trip.body);
  try {
    const { fareNaira } = await priceTrip(trip.value);
    return res.json({ fareNaira, bookingType: trip.value.bookingType, vehicleType: trip.value.vehicleType });
  } catch (error) {
    return res.status(400).json({
      error: error instanceof Error ? error.message : "Unable to calculate the fare for this trip.",
    });
  }
});

// POST /api/public/easybook/requests
// Creates the pending booking, the invoice and the Paystack pay link, and emails
// the invoice (and WhatsApps the link). The ride itself appears on the ops
// dashboard only after payment, via the webhook.
router.post("/easybook/requests", submitLimiter, async (req, res) => {
  const body = req.body || {};

  const idempotencyKey = String(body.idempotencyKey || "").trim();
  if (!UUID_RE.test(idempotencyKey)) {
    return res.status(400).json({ error: "idempotencyKey must be a UUID." });
  }

  const parsed = validateSubmission(body);
  if (!parsed.ok) return res.status(parsed.status).json(parsed.body);
  const { contact, trip, helperName } = parsed.value;

  const submittedVia = (helperName ? `easybook-helper:${helperName}` : "easybook").slice(0, 80);

  const requestFingerprint = crypto
    .createHash("sha256")
    .update(JSON.stringify({ email: contact.email, ...trip }))
    .digest("hex");

  // Same submission again (double tap, network retry): hand back the same
  // invoice instead of creating a second one.
  const existing = await pool.query(
    `SELECT b.*, u.name AS rider_name FROM support_assisted_bookings b
       JOIN users u ON u.id = b.rider_id WHERE b.idempotency_key = $1`,
    [idempotencyKey]
  );
  if (existing.rows[0]) {
    const prior = existing.rows[0];
    if (prior.source !== "public_self_service" || prior.request_fingerprint !== requestFingerprint) {
      return res.status(409).json({ error: "That request has already been used. Please refresh and try again." });
    }
    return res.status(200).json({
      ok: true,
      repeated: true,
      invoice: publicInvoice(prior),
      invoiceUrl: invoiceUrlFor(prior.invoice_token),
    });
  }

  // Per-email cap: stops this being used to flood one person with invoices.
  const recent = await pool.query(
    `SELECT count(*)::int AS n
       FROM support_assisted_bookings b JOIN users u ON u.id = b.rider_id
      WHERE u.email = $1 AND b.source = 'public_self_service'
        AND b.created_at > now() - interval '1 hour'`,
    [contact.email]
  );
  if (recent.rows[0].n >= MAX_PENDING_PER_EMAIL_PER_HOUR) {
    return res.status(429).json({
      error: "We already sent several invoices to this email in the last hour. Please check that inbox, or message us on WhatsApp.",
    });
  }

  let priced;
  try {
    priced = await priceTrip(trip);
  } catch (error) {
    return res.status(400).json({
      error: error instanceof Error ? error.message : "Unable to calculate the fare for this trip.",
    });
  }
  const { fareNaira, ngnPerUsd } = priced;
  const quotedUsdAmount = Number((Number(fareNaira) / Number(ngnPerUsd)).toFixed(2));

  const riderResult = await findOrCreateRider(contact);
  if (riderResult.error) return res.status(409).json({ error: riderResult.error });
  const rider = riderResult.rider;

  const invoiceToken = crypto.randomBytes(24).toString("hex");

  let booking;
  try {
    const inserted = await pool.query(
      `INSERT INTO support_assisted_bookings (
         rider_id, idempotency_key, request_fingerprint, source,
         payment_method, payment_status, payment_status_at_creation,
         booking_request, fare_naira, quoted_ngn_per_usd, quoted_usd_amount,
         submitted_via, submitted_via_ip, invoice_token
       ) VALUES ($1,$2,$3,'public_self_service','card','pending','pending',$4::jsonb,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [
        rider.id,
        idempotencyKey,
        requestFingerprint,
        // contactPhone rides along (out of the fingerprint) so
        // createRideFromAssistedBooking can put it on the account.
        JSON.stringify({ ...trip, agreedCancellationPolicy: true, contactPhone: contact.phone }),
        fareNaira,
        ngnPerUsd,
        quotedUsdAmount,
        submittedVia,
        req.ip || null,
        invoiceToken,
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
        return res.status(409).json({ error: "That request has already been used. Please refresh and try again." });
      }
    } else {
      throw error;
    }
  }

  // Invoice number from the row id: short, readable, and unique for free.
  if (!booking.invoice_number) {
    const numbered = await pool.query(
      `UPDATE support_assisted_bookings
          SET invoice_number = 'INV-' || to_char(created_at AT TIME ZONE 'Africa/Lagos', 'YYYY') || '-' || lpad(id::text, 5, '0')
        WHERE id = $1 AND invoice_number IS NULL RETURNING invoice_number`,
      [booking.id]
    );
    booking.invoice_number = numbered.rows[0]?.invoice_number || `INV-${booking.id}`;
  }

  // The booking is durable from here. Paystack, email and WhatsApp are best
  // effort: staff can always finish it from the dashboard, and the customer
  // can reload the invoice page.
  let authorizationUrl = booking.payment_link_url;
  let reference = booking.payment_reference;
  if (!authorizationUrl) {
    try {
      const initialized = await initializePaystackTransaction({ email: rider.email, amountNaira: Number(booking.fare_naira) });
      authorizationUrl = initialized.authorizationUrl;
      reference = initialized.reference;
      await pool.query(
        `UPDATE support_assisted_bookings
            SET payment_reference = $1, payment_link_url = $2, payment_link_sent_at = now(), updated_at = now()
          WHERE id = $3`,
        [reference, authorizationUrl, booking.id]
      );
      booking.payment_link_url = authorizationUrl;
      booking.payment_reference = reference;
    } catch (err) {
      console.error("EasyBook Paystack initialize failed:", err.response?.data || err.message);
    }
  }

  const invoiceUrl = invoiceUrlFor(booking.invoice_token);
  let emailSent = false;
  if (authorizationUrl) {
    try {
      const result = await sendInvoiceEmail(rider.email, {
        name: contact.name,
        invoiceNumber: booking.invoice_number,
        request: booking.booking_request,
        fareNaira: Number(booking.fare_naira),
        payUrl: authorizationUrl,
        invoiceUrl,
      });
      emailSent = !!result?.ok;
      if (emailSent) {
        await pool.query("UPDATE support_assisted_bookings SET invoice_sent_at = now() WHERE id = $1", [booking.id]);
      }
    } catch (err) {
      console.error("EasyBook invoice email failed:", err.message);
    }
  }

  let whatsappSent = false;
  if (authorizationUrl) {
    const fareDisplay = "NGN " + Number(booking.fare_naira).toLocaleString("en-NG");
    const message =
      `Hi ${contact.name}, here is your RideArrivo invoice ${booking.invoice_number} for ${fareDisplay}.\n\n` +
      `Pay securely here: ${authorizationUrl}\n\n` +
      `Your ride is confirmed as soon as it is paid, and we will email your receipt. If you did not request this, please ignore it.`;
    try {
      const sendResult = await sendWhatsAppMessage(contact.phone, message);
      whatsappSent = !!sendResult?.ok;
    } catch (err) {
      console.error("EasyBook WhatsApp send failed:", err.message);
    }
  }

  const fresh = await pool.query(
    `SELECT b.*, u.name AS rider_name FROM support_assisted_bookings b
       JOIN users u ON u.id = b.rider_id WHERE b.id = $1`,
    [booking.id]
  );

  return res.status(201).json({
    ok: true,
    invoice: publicInvoice(fresh.rows[0]),
    invoiceUrl,
    emailSent,
    whatsappSent,
    message: authorizationUrl
      ? "Your invoice is ready. Pay securely to confirm the ride. We also sent it to your email" +
        (whatsappSent ? " and WhatsApp." : ".")
      : "We saved your booking, but could not start payment automatically. Our team will follow up shortly.",
  });
});

// GET /api/public/easybook/invoices/:token
// The invoice page. The 48 hex character token is the only key, so one
// customer can never read another's invoice by guessing.
router.get("/easybook/invoices/:token", invoiceLimiter, async (req, res) => {
  const token = String(req.params.token || "");
  if (!TOKEN_RE.test(token)) return res.status(404).json({ error: "We could not find that invoice." });
  const result = await pool.query(
    `SELECT b.*, u.name AS rider_name FROM support_assisted_bookings b
       JOIN users u ON u.id = b.rider_id WHERE b.invoice_token = $1`,
    [token]
  );
  if (!result.rows[0]) return res.status(404).json({ error: "We could not find that invoice." });
  res.set("Cache-Control", "no-store");
  return res.json({ invoice: publicInvoice(result.rows[0]) });
});

module.exports = router;
