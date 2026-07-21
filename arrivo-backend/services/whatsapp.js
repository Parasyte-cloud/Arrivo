// Sends WhatsApp messages via Twilio's WhatsApp API (twilio.com/whatsapp).
// Sign up, grab your Account SID + Auth Token from the Twilio console, and
// set TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_WHATSAPP_FROM in your
// .env — see .env.example.
//
// Twilio's Sandbox mode (a shared test number) works immediately with no
// Meta Business verification, which is why it's the fastest path to testing
// this today — each recipient just has to send the sandbox's join code once
// from their own WhatsApp. A real WhatsApp Business number (needed to
// message anyone without that one-time opt-in step) requires Meta Business
// verification and takes longer to set up; swap TWILIO_WHATSAPP_FROM to the
// approved number once that's done and nothing else here changes.
//
// Follows the same fire-and-forget-with-timeout pattern as services/email.js
// and services/pushNotifications.js: a failed/slow WhatsApp send should
// never block or fail the API request that triggered it (e.g. a driver
// accepting a ride shouldn't 500 just because WhatsApp delivery hiccuped).

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
// Twilio's own default sandbox number — works out of the box once the
// recipient has joined the sandbox, so this is a sane default rather than
// an inert 'replace_me'-style placeholder.
const TWILIO_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM || "whatsapp:+14155238886";

async function sendWhatsAppMessage(to, body) {
  if (!to) return { skipped: true };
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
    console.warn(`[whatsapp] TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN not set — skipping WhatsApp message to ${to}`);
    return { skipped: true };
  }

  // Numbers are stored in the DB as plain international-format phone
  // numbers (e.g. "+2348012345678") — Twilio's WhatsApp API needs the
  // "whatsapp:" scheme prefix on both ends of the message.
  const toAddress = to.startsWith("whatsapp:") ? to : `whatsapp:${to}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: "Basic " + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64"),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ From: TWILIO_WHATSAPP_FROM, To: toAddress, Body: body }),
        signal: controller.signal,
      }
    );
    if (!res.ok) {
      const errBody = await res.text();
      console.error(`[whatsapp] Twilio API returned ${res.status} for ${to}:`, errBody);
      return { ok: false };
    }
    return { ok: true };
  } catch (e) {
    console.error(`[whatsapp] Failed to send to ${to}:`, e.name === "AbortError" ? "timed out after 10s" : e.message);
    return { ok: false };
  } finally {
    clearTimeout(timeout);
  }
}

// Shared message builders — kept here (rather than inline at each call
// site) so the copy stays consistent between the accept-ride notification
// and anything else that ends up sending a similar message later.
function driverAssignedMessage(ride, driverName, vehicleLabel) {
  return (
    `🚗 *RideArrivo* — your driver is confirmed!\n\n` +
    `Driver: ${driverName}\n` +
    `Vehicle: ${vehicleLabel || "Details coming shortly"}\n` +
    `Pickup: ${ride.pickup_address}\n` +
    (ride.scheduled_pickup_at ? `Scheduled: ${new Date(ride.scheduled_pickup_at).toLocaleString()}\n` : "") +
    `\nTrack your ride live in the RideArrivo app or at ridearrivo.com/track.html?ride=${ride.id}`
  );
}

function flightIssueMessage(ride, reason) {
  const reasonText = reason === "cancelled" ? "has been cancelled" : "has been rescheduled";
  return (
    `✈️ *RideArrivo* — heads up about your flight\n\n` +
    `We noticed flight ${ride.flight_number} ${reasonText}. Your original charge has been refunded to your RideArrivo wallet.\n\n` +
    `To keep your ride booked, please make sure you have at least $100 (or its naira equivalent) in your wallet — this covers the trip, which will now be charged when you're dropped off instead of upfront. ` +
    `Once your new travel time is confirmed, update it in the app or on ridearrivo.com.`
  );
}

function driverChangedMessage(ride, reason) {
  return (
    `ℹ️ *RideArrivo* — a quick update on your driver\n\n` +
    `We couldn't keep the same driver for this trip: ${reason || "they weren't available in time for this pickup."}\n\n` +
    `Don't worry — we've matched you with another verified RideArrivo driver, and you'll get their details as soon as they accept.`
  );
}

module.exports = {
  sendWhatsAppMessage,
  driverAssignedMessage,
  flightIssueMessage,
  driverChangedMessage,
};
