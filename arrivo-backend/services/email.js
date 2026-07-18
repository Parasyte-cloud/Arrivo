// Sends transactional emails via Resend (resend.com).
// Sign up free, get an API key from the dashboard, and set RESEND_API_KEY
// and EMAIL_FROM in your .env — see .env.example.
//
// Free tier: 3,000 emails/month, 100/day — plenty for testing and an early launch.

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM || "RideArrivo <onboarding@resend.dev>";

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
      <p><strong>Pickup:</strong> ${ride.pickup_address}</p>
      <p><strong>Fare:</strong> ₦${Number(ride.fare_naira).toLocaleString()}</p>
      <p><strong>Reference:</strong> ${ride.payment_reference || ride.id}</p>
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
      <p>Hi ${name},</p>
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

module.exports = { sendPasswordResetEmail, sendBookingConfirmationEmail, sendWelcomeEmail, sendVerificationEmail };
