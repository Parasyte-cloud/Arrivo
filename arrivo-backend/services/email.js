// Sends transactional emails via Resend (resend.com).
// Sign up free, get an API key from the dashboard, and set RESEND_API_KEY
// and EMAIL_FROM in your .env — see .env.example.
//
// Free tier: 3,000 emails/month, 100/day — plenty for testing and an early launch.

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM || "RideArrivo <onboarding@resend.dev>";

// User-controlled strings (a rider's typed address, a driver's own display
// name, a payment reference echoed back, a flight number) get interpolated
// straight into these HTML email bodies below. Without escaping, something
// like a driver setting their name to `<img src=x onerror=...>` would run
// as real HTML in whatever mail client renders it. Only used on the HTML
// templates — plain-text bodies (none currently sent from this file) would
// display escape sequences literally and must never be run through this.
function escapeHtml(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function sendEmail({ to, subject, html }) {
  if (!RESEND_API_KEY) {
    console.warn(`[email] RESEND_API_KEY not set — skipping email to ${to}: "${subject}"`);
    return { skipped: true };
  }

  // Without an explicit timeout, a slow or unreachable Resend API call
  // could hang indefinitely — on a resource-constrained free-tier
  // instance, enough of these piling up (one per signup/reset/booking)
  // can exhaust available connections and make the whole server
  // unresponsive to unrelated requests too, not just email-triggering
  // ones. Fail fast instead: 10 seconds is generous for a simple POST.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  let res;
  try {
    res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: EMAIL_FROM, to, subject, html }),
      signal: controller.signal,
    });
  } catch (e) {
    console.error(`[email] Failed to reach Resend for ${to}:`, e.name === "AbortError" ? "timed out after 10s" : e.message);
    return { ok: false };
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const body = await res.text();
    console.error(`[email] Failed to send to ${to}:`, res.status, body);
    return { ok: false };
  }
  return { ok: true };
}

function wrapper(bodyHtml) {
  return `
    <div style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
      <div style="font-weight: 700; font-size: 20px; color: #12123B; margin-bottom: 24px;"><span style="color:#12123B">Ride</span><span style="color:#F4A300">Arrivo</span></div>
      ${bodyHtml}
      <p style="color: #9494BE; font-size: 12px; margin-top: 32px;">RideArrivo. Lagos, Nigeria</p>
    </div>
  `;
}

function sendPasswordResetEmail(to, resetUrl) {
  return sendEmail({
    to,
    subject: "Reset your RideArrivo password",
    html: wrapper(`
      <p>We received a request to reset your RideArrivo password.</p>
      <p><a href="${resetUrl}" style="background:#F4A300;color:#12123B;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block;">Reset Password</a></p>
      <p style="color:#6b6b85;font-size:13px;">This link expires in 1 hour. If you didn't request this, you can safely ignore this email.</p>
    `),
  });
}

function sendBookingConfirmationEmail(to, ride) {
  return sendEmail({
    to,
    subject: "Your RideArrivo booking is confirmed",
    html: wrapper(`
      <p>Your ride is booked and paid for.</p>
      <p><strong>Pickup:</strong> ${escapeHtml(ride.pickup_address)}</p>
      <p><strong>Fare:</strong> ₦${Number(ride.fare_naira).toLocaleString()}</p>
      <p><strong>Reference:</strong> ${escapeHtml(ride.payment_reference || ride.id)}</p>
      <p style="color:#6b6b85;font-size:13px;">We'll be in touch with your driver's details closer to pickup time.</p>
      <p style="color:#6b6b85;font-size:13px;">Need to cancel or change your booking? Read our <a href="https://ridearrivo.com/terms.html#cancellation">Cancellation &amp; Refund Policy</a> before doing so.</p>
    `),
  });
}

function sendWelcomeEmail(to, name) {
  return sendEmail({
    to,
    subject: "Welcome to RideArrivo",
    html: wrapper(`
      <p>Hi ${escapeHtml(name)},</p>
      <p>Your RideArrivo account is ready. Land in Lagos. Arrive. Relax.</p>
    `),
  });
}

function sendVerificationEmail(to, verifyUrl) {
  return sendEmail({
    to,
    subject: "Verify your RideArrivo email",
    html: wrapper(`
      <p>Thanks for creating your RideArrivo profile. Please verify your email to finish setting it up.</p>
      <p><a href="${verifyUrl}" style="background:#F4A300;color:#12123B;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block;">Verify Email</a></p>
      <p style="color:#6b6b85;font-size:13px;">This link expires in 24 hours.</p>
    `),
  });
}

function sendDriverAssignedEmail(to, ride, driverName, vehicleLabel) {
  return sendEmail({
    to,
    subject: "Your RideArrivo driver is confirmed",
    html: wrapper(`
      <p>Good news: a driver has been matched to your ride.</p>
      <p><strong>Driver:</strong> ${escapeHtml(driverName)}</p>
      <p><strong>Vehicle:</strong> ${vehicleLabel ? escapeHtml(vehicleLabel) : "Details coming shortly"}</p>
      <p><strong>Pickup:</strong> ${escapeHtml(ride.pickup_address)}</p>
      ${ride.scheduled_pickup_at ? `<p><strong>Scheduled:</strong> ${new Date(ride.scheduled_pickup_at).toLocaleString()}</p>` : ""}
      <p style="color:#6b6b85;font-size:13px;">Track your ride live in the RideArrivo app, or at <a href="https://ridearrivo.com/track.html?ride=${ride.id}">ridearrivo.com/track.html</a>.</p>
    `),
  });
}

// Sent when the scheduler (services/scheduler.js) detects that a tracked
// flight tied to a ride has been cancelled or rescheduled — see the
// original_flight_scheduled_at/flight_issue columns in db/schema.sql for
// the detection logic, and the wallet-refund + $100-minimum + charge-at-
// completion flow in routes/rides.js.
function sendFlightIssueEmail(to, ride, reason) {
  const reasonText = reason === "cancelled" ? "has been cancelled" : "has been rescheduled";
  return sendEmail({
    to,
    subject: `Your flight ${ride.flight_number || ""} ${reasonText}: quick update on your RideArrivo booking`,
    html: wrapper(`
      <p>We noticed flight <strong>${escapeHtml(ride.flight_number) || "N/A"}</strong> ${reasonText}.</p>
      <p>Your original fare has been refunded to your RideArrivo wallet. To keep your ride booked, please make sure you have at least <strong>$100</strong> (or its naira equivalent) in your wallet. This covers the trip, which will now be charged when you're dropped off instead of upfront.</p>
      <p style="color:#6b6b85;font-size:13px;">Once your new travel time is confirmed, you can update it from the app or ridearrivo.com. Questions? Just reply to this email.</p>
    `),
  });
}

// Sent when a ride's preferred driver (set via "keep the same driver for my
// return trip" at Rate & Relax) couldn't be retained — the claim window
// elapsed unaccepted, or the driver went offline — so the change never
// arrives as a silent surprise. See driver_change_reason in db/schema.sql.
function sendDriverChangedEmail(to, ride, reason) {
  return sendEmail({
    to,
    subject: "A quick update on your RideArrivo driver",
    html: wrapper(`
      <p>We tried to keep the same driver for your return trip, but couldn't: ${reason || "they weren't available in time for this pickup."}</p>
      <p>Don't worry, we've opened this ride up to our other verified drivers, and you'll get their details as soon as one accepts.</p>
    `),
  });
}

// ── EasyBook invoice and receipt ──
// Sent for bookings made through easybookings.ridearrivo.com (and any other
// assisted booking). The invoice carries the Paystack pay link; the receipt
// goes out once the payment webhook has confirmed the money and created the
// ride. Every user-supplied value goes through escapeHtml.
const BOOKING_TYPE_LABELS = {
  one_way: "Airport pickup",
  dropoff: "Airport drop-off",
  full_day: "Chauffeur by the day",
  full_week: "Chauffeur for a week",
  full_month: "Chauffeur for a month",
};
const VEHICLE_LABELS = { sedan: "Sedan", suv: "SUV", truck: "Executive", pickup: "Pickup truck" };

function naira(amount) {
  return "₦" + Number(amount || 0).toLocaleString("en-NG");
}

function whenLagos(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString("en-GB", {
    timeZone: "Africa/Lagos",
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }) + " (Lagos time)";
}

function tripRows(request) {
  const r = request || {};
  const rows = [];
  rows.push(["Trip", BOOKING_TYPE_LABELS[r.bookingType] || "Ride"]);
  rows.push(["Vehicle", VEHICLE_LABELS[r.vehicleType] || r.vehicleType || ""]);
  rows.push([r.bookingType === "one_way" || r.bookingType === "dropoff" ? "From" : "Meet at", r.pickupAddress]);
  if (r.destinationAddress) rows.push(["To", r.destinationAddress]);
  if (r.flightNumber) rows.push(["Flight", r.flightNumber + (r.flightDate ? " on " + r.flightDate : "")]);
  const when = whenLagos(r.scheduledPickupAt);
  if (when) rows.push([r.bookingType === "dropoff" ? "Pickup time" : "Starts", when]);
  if (r.bookingType === "full_day" && Number(r.durationDays) > 1) rows.push(["Days", String(r.durationDays)]);
  rows.push(["Passengers", String((Number(r.adults) || 1) + (Number(r.children) || 0))]);
  if (r.securityEscort) rows.push(["Extras", "Security escort"]);
  if (r.luxury) rows.push(["Extras", "Luxury upgrade"]);
  if (r.notes) rows.push(["Notes", r.notes]);
  return rows.filter(([, v]) => v);
}

function rowsHtml(rows) {
  return rows
    .map(
      ([k, v]) =>
        `<tr><td style="padding:6px 12px 6px 0;color:#6b6b85;font-size:13px;vertical-align:top;white-space:nowrap;">${escapeHtml(k)}</td><td style="padding:6px 0;font-size:14px;color:#12123B;">${escapeHtml(v)}</td></tr>`
    )
    .join("");
}

function sendInvoiceEmail(to, { name, invoiceNumber, request, fareNaira, payUrl, invoiceUrl }) {
  return sendEmail({
    to,
    subject: `Invoice ${invoiceNumber} from RideArrivo: ${naira(fareNaira)} to confirm your ride`,
    html: wrapper(`
      <p>Hi ${escapeHtml(name || "there")},</p>
      <p>Thank you for booking with RideArrivo. Here is your invoice. Your ride is confirmed as soon as it is paid.</p>
      <table style="border-collapse:collapse;width:100%;margin:12px 0;">
        <tr><td style="padding:6px 12px 6px 0;color:#6b6b85;font-size:13px;">Invoice</td><td style="padding:6px 0;font-size:14px;font-weight:700;color:#12123B;">${escapeHtml(invoiceNumber)}</td></tr>
        ${rowsHtml(tripRows(request))}
        <tr><td style="padding:10px 12px 6px 0;color:#6b6b85;font-size:13px;border-top:1px solid #e6e6f0;">Total due</td><td style="padding:10px 0 6px 0;font-size:20px;font-weight:700;color:#12123B;border-top:1px solid #e6e6f0;">${naira(fareNaira)}</td></tr>
      </table>
      <p><a href="${escapeHtml(payUrl)}" style="background:#F4A300;color:#12123B;padding:14px 24px;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block;">Pay ${naira(fareNaira)} securely</a></p>
      <p style="color:#6b6b85;font-size:13px;">Payment is handled by Paystack. We will email your receipt the moment it goes through. You can also view this invoice any time at <a href="${escapeHtml(invoiceUrl)}">${escapeHtml(invoiceUrl)}</a>.</p>
      <p style="color:#6b6b85;font-size:13px;">Need to cancel or change your booking? Read our <a href="https://ridearrivo.com/terms.html#cancellation">Cancellation &amp; Refund Policy</a>. If you did not request this, please ignore this email.</p>
    `),
  });
}

function sendReceiptEmail(to, { name, invoiceNumber, request, paidNaira, reference, paidAt, rideId }) {
  return sendEmail({
    to,
    subject: `Receipt for ${invoiceNumber}: payment received, your RideArrivo ride is booked`,
    html: wrapper(`
      <p>Hi ${escapeHtml(name || "there")},</p>
      <p>Payment received. Thank you! Your RideArrivo ride is booked and our team has it.</p>
      <table style="border-collapse:collapse;width:100%;margin:12px 0;">
        <tr><td style="padding:6px 12px 6px 0;color:#6b6b85;font-size:13px;">Receipt for</td><td style="padding:6px 0;font-size:14px;font-weight:700;color:#12123B;">${escapeHtml(invoiceNumber)}</td></tr>
        <tr><td style="padding:6px 12px 6px 0;color:#6b6b85;font-size:13px;">Ride</td><td style="padding:6px 0;font-size:14px;color:#12123B;">#${escapeHtml(rideId)}</td></tr>
        ${rowsHtml(tripRows(request))}
        <tr><td style="padding:6px 12px 6px 0;color:#6b6b85;font-size:13px;">Paid on</td><td style="padding:6px 0;font-size:14px;color:#12123B;">${escapeHtml(whenLagos(paidAt) || "")}</td></tr>
        <tr><td style="padding:6px 12px 6px 0;color:#6b6b85;font-size:13px;">Payment reference</td><td style="padding:6px 0;font-size:14px;color:#12123B;">${escapeHtml(reference)}</td></tr>
        <tr><td style="padding:10px 12px 6px 0;color:#6b6b85;font-size:13px;border-top:1px solid #e6e6f0;">Amount paid</td><td style="padding:10px 0 6px 0;font-size:20px;font-weight:700;color:#12123B;border-top:1px solid #e6e6f0;">${naira(paidNaira)}</td></tr>
      </table>
      <p style="color:#6b6b85;font-size:13px;">We will send your driver's details closer to pickup time. Track your ride at <a href="https://ridearrivo.com/track.html?ride=${escapeHtml(rideId)}">ridearrivo.com</a>. Keep this email as your proof of payment.</p>
      <p style="color:#6b6b85;font-size:13px;">Need to cancel or change your booking? Read our <a href="https://ridearrivo.com/terms.html#cancellation">Cancellation &amp; Refund Policy</a> or reply to this email.</p>
    `),
  });
}

module.exports = {
  sendInvoiceEmail,
  sendReceiptEmail,
  tripRows,
  sendEmail,
  escapeHtml,
  sendPasswordResetEmail,
  sendBookingConfirmationEmail,
  sendWelcomeEmail,
  sendVerificationEmail,
  sendDriverAssignedEmail,
  sendFlightIssueEmail,
  sendDriverChangedEmail,
};
