// Real-time panic paging. Before this, POST /api/rides/:id/panic only
// wrote the ride row and logged a line: the admin dashboard's Panic Alerts
// page polls every 10s, so a panic was only ever seen if someone happened
// to have that page open. This pushes every panic straight to the people
// on call, by email and WhatsApp, using the same Resend / Twilio services
// the rest of the backend already sends through.
//
// Recipients come from env, comma-separated, so ops can change who's on
// call without a deploy:
//   OPS_ALERT_EMAILS    e.g. "ops@ridearrivo.com,wuraola@ridearrivo.com"
//   OPS_ALERT_WHATSAPP  e.g. "+2348162706078,+2348000000000"
// If neither is set, a loud warning is logged on every panic so the gap is
// visible in Render's logs instead of silent.
//
// Never throws and never delays the response to the person who pressed
// the button: callers fire it without awaiting.
const { sendEmail, escapeHtml } = require("./email");
const { sendWhatsAppMessage } = require("./whatsapp");

function list(envName) {
  return (process.env[envName] || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function mapsLink(lat, lng) {
  if (lat == null || lng == null) return null;
  return `https://maps.google.com/?q=${Number(lat)},${Number(lng)}`;
}

// details: { ride, triggeredBy: { name, email, role }, rider: {name, phone},
//            driver: {name, phone, lat, lng, locationUpdatedAt} | null }
async function sendPanicAlert(pool, rideId, triggeredByUserId) {
  try {
    const emails = list("OPS_ALERT_EMAILS");
    const phones = list("OPS_ALERT_WHATSAPP");
    if (!emails.length && !phones.length) {
      console.error(`🚨 PANIC on ride #${rideId} but OPS_ALERT_EMAILS / OPS_ALERT_WHATSAPP are not set, so nobody was paged. Set them on Render.`);
      return { skipped: true };
    }

    const result = await pool.query(
      `SELECT rides.id, rides.pickup_address, rides.stops, rides.panic_notes, rides.panic_triggered_at,
              rides.emergency_contact_name, rides.emergency_contact_phone,
              rider.name AS rider_name, rider.phone AS rider_phone, rider.whatsapp_number AS rider_whatsapp,
              du.name AS driver_name, du.phone AS driver_phone,
              drivers.current_lat, drivers.current_lng, drivers.location_updated_at,
              trig.name AS trig_name, trig.role AS trig_role
       FROM rides
       JOIN users rider ON rider.id = rides.rider_id
       LEFT JOIN drivers ON drivers.id = rides.driver_id
       LEFT JOIN users du ON du.id = drivers.user_id
       LEFT JOIN users trig ON trig.id = $2
       WHERE rides.id = $1`,
      [rideId, triggeredByUserId]
    );
    const r = result.rows[0];
    if (!r) return { skipped: true };

    let stops = [];
    try { stops = JSON.parse(r.stops || "[]"); } catch (_) {}
    const destination = stops.length ? stops[stops.length - 1] : "";
    const where = mapsLink(r.current_lat, r.current_lng);
    const who = r.trig_role === "driver" ? `the DRIVER (${r.trig_name || "unknown"})` : `the RIDER (${r.trig_name || "unknown"})`;
    const riderPhone = r.rider_whatsapp || r.rider_phone || "not on file";
    const lines = [
      `🚨 RIDEARRIVO PANIC: Ride #${r.id}`,
      `Triggered by ${who}.`,
      `Rider: ${r.rider_name || "?"} ${riderPhone}`,
      `Driver: ${r.driver_name ? `${r.driver_name} ${r.driver_phone || ""}` : "not yet assigned"}`,
      `Route: ${r.pickup_address || "?"} → ${destination || "?"}`,
      where ? `Driver's last GPS${r.location_updated_at ? ` (${new Date(r.location_updated_at).toISOString()})` : ""}: ${where}` : "Driver's live location: unavailable",
      r.emergency_contact_name ? `Emergency contact: ${r.emergency_contact_name} ${r.emergency_contact_phone || ""}` : null,
      r.panic_notes ? `Note: ${r.panic_notes}` : null,
      `Open: https://admin.ridearrivo.com/#panics`,
    ].filter(Boolean);
    const text = lines.join("\n");

    const sends = [];
    for (const to of phones) sends.push(sendWhatsAppMessage(to, text));
    if (emails.length) {
      sends.push(
        sendEmail({
          to: emails,
          subject: `🚨 PANIC: RideArrivo ride #${r.id}`,
          html: `<pre style="font:14px/1.5 -apple-system,Segoe UI,sans-serif;white-space:pre-wrap">${escapeHtml(text)}</pre>`,
        })
      );
    }
    const outcomes = await Promise.allSettled(sends);
    const delivered = outcomes.filter((o) => o.status === "fulfilled" && o.value && o.value.ok).length;
    if (!delivered) console.error(`🚨 PANIC on ride #${r.id}: alert delivery failed on every channel. Check RESEND_API_KEY / Twilio settings.`);
    return { delivered, attempted: sends.length };
  } catch (err) {
    console.error(`🚨 PANIC alert for ride #${rideId} failed:`, err.message);
    return { ok: false };
  }
}

module.exports = { sendPanicAlert };
