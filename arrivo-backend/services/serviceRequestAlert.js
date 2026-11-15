// Pages the people on call (same OPS_ALERT_EMAILS / OPS_ALERT_WHATSAPP lists as panic alerts)
// when a rider orders Campus, Air, Boat or Removals, because Ops has to confirm the price
// before a driver can start the trip. Never throws and is never awaited by the request.
const { sendEmail, escapeHtml } = require("./email");
const { sendWhatsAppMessage } = require("./whatsapp");

const list = (n) => (process.env[n] || "").split(",").map((s) => s.trim()).filter(Boolean);

async function sendServiceRequestAlert(pool, rideId) {
  try {
    const emails = list("OPS_ALERT_EMAILS"), phones = list("OPS_ALERT_WHATSAPP");
    if (!emails.length && !phones.length) {
      console.error(`New service request #${rideId} but OPS_ALERT_EMAILS / OPS_ALERT_WHATSAPP are not set, so Ops was not told. Set them on Render.`);
      return { skipped: true };
    }
    const r = (await pool.query(
      `SELECT rides.id, rides.service, rides.pickup_address, rides.stops, rides.scheduled_pickup_at, rides.rider_note,
              rides.contact_phone, rides.passenger_count, u.name AS rider_name, u.email AS rider_email
       FROM rides JOIN users u ON u.id = rides.rider_id WHERE rides.id = $1`, [rideId])).rows[0];
    if (!r) return { skipped: true };
    let stops = []; try { stops = JSON.parse(r.stops || "[]"); } catch (_) {}
    const text = [
      `NEW ${String(r.service).toUpperCase()} REQUEST #${r.id}: set the price`,
      `Rider: ${r.rider_name || "?"} ${r.contact_phone || ""}`,
      `Route: ${r.pickup_address} to ${stops[stops.length - 1] || "?"}`,
      r.passenger_count ? `Passengers: ${r.passenger_count}` : null,
      r.rider_note ? `Note: ${r.rider_note}` : null,
      "Call the rider, agree the price, then set it on the Rides page. Drivers with this service can already see it but cannot start until the price is set.",
      "Open: https://admin.ridearrivo.com/#rides",
    ].filter(Boolean).join("\n");
    const sends = phones.map((to) => sendWhatsAppMessage(to, text));
    if (emails.length) sends.push(sendEmail({ to: emails, subject: `New ${r.service} request #${r.id}: set the price`, html: `<pre style="font:14px/1.5 -apple-system,Segoe UI,sans-serif;white-space:pre-wrap">${escapeHtml(text)}</pre>` }));
    const out = await Promise.allSettled(sends);
    const delivered = out.filter((o) => o.status === "fulfilled" && o.value && o.value.ok).length;
    if (!delivered) console.error(`Service request #${r.id}: alert delivery failed on every channel.`);
    return { delivered, attempted: sends.length };
  } catch (err) {
    console.error(`Service request alert for #${rideId} failed:`, err.message);
    return { ok: false };
  }
}
module.exports = { sendServiceRequestAlert };
