// Pages the on-call people when a rider sends an On the Go request.
//
// These are time-critical (the rider needs a car within hours) and until now
// they only landed in a table, so nobody knew unless they went looking. This
// uses the same OPS_ALERT_EMAILS / OPS_ALERT_WHATSAPP recipients as the panic
// alert, so ops changes who is on call in one place:
//   OPS_ALERT_EMAILS    e.g. "ops@ridearrivo.com,wuraola@ridearrivo.com"
//   OPS_ALERT_WHATSAPP  e.g. "+2348162706078"
// If neither is set, a warning is logged so the gap shows up in Render's logs.
//
// Never throws and never delays the rider's response: callers fire it without
// awaiting.
const { sendEmail, escapeHtml } = require("./email");
const { sendWhatsAppMessage } = require("./whatsapp");

function list(envName) {
  return (process.env[envName] || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// "Sat 10 Oct, 14:30 (Lagos time)". Always Lagos, whatever zone the server runs in.
function formatLagos(iso) {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return null;
  const text = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Lagos",
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
  return `${text} (Lagos time)`;
}

// request: an on_the_go_requests row. rider: { name, email } or null.
function buildAlertText(request, rider) {
  const when = formatLagos(request.requested_pickup_at);
  const lines = [
    `ON THE GO request #${request.id}${request.source_service ? ` (from ${request.source_service})` : ""}`,
    when ? `Wants the car: ${when}` : "Wants the car: as soon as possible",
    `Pickup: ${request.pickup_address}`,
    `Destination: ${request.destination_address}`,
    request.flight_number ? `Flight: ${request.flight_number}` : null,
    `Passengers: ${request.passenger_count}`,
    `Ring: ${request.contact_phone}`,
    rider && rider.name ? `Rider: ${rider.name}${rider.email ? ` (${rider.email})` : ""}` : null,
    request.details ? `Details: ${request.details}` : null,
    "Open: https://admin.ridearrivo.com/#on-the-go",
  ].filter(Boolean);
  return lines.join("\n");
}

async function sendOnTheGoAlert(pool, request) {
  try {
    const emails = list("OPS_ALERT_EMAILS");
    const phones = list("OPS_ALERT_WHATSAPP");
    if (!emails.length && !phones.length) {
      console.error(
        `On the Go request #${request.id} saved but OPS_ALERT_EMAILS / OPS_ALERT_WHATSAPP are not set, so nobody was alerted.`
      );
      return { skipped: true };
    }
    const found = await pool.query("SELECT name, email FROM users WHERE id = $1", [request.user_id]);
    const text = buildAlertText(request, found.rows[0] || null);

    const sends = [];
    for (const to of phones) sends.push(sendWhatsAppMessage(to, text));
    if (emails.length) {
      sends.push(
        sendEmail({
          to: emails,
          subject: `On the Go request #${request.id}: ${request.pickup_address}`.slice(0, 150),
          html: `<pre style="font:14px/1.5 -apple-system,Segoe UI,sans-serif;white-space:pre-wrap">${escapeHtml(text)}</pre>`,
        })
      );
    }
    const outcomes = await Promise.allSettled(sends);
    const delivered = outcomes.filter((o) => o.status === "fulfilled" && o.value && o.value.ok).length;
    if (!delivered) console.error(`On the Go request #${request.id}: alert delivery failed on every channel.`);
    return { delivered, attempted: sends.length };
  } catch (err) {
    console.error(`On the Go alert for request #${request.id} failed:`, err.message);
    return { ok: false };
  }
}

module.exports = { buildAlertText, formatLagos, sendOnTheGoAlert };
