// Pure rules behind the Command Center queue, kept out of the component so they can be tested.
// Inputs are the rows from GET /api/admin/trips/active.

export const PICKUP_WINDOW_MIN = 45; // a booked pickup with no driver this close is an exception
export const ONDEMAND_WAIT_MIN = 5; // an on-demand ride nobody has taken after this long is an exception
export const GPS_SILENT_MIN = 4; // a driver on a live ride whose phone has not reported for this long
export const AIRPORT_LOOKAHEAD_MIN = 180; // upcoming airport pickups are listed this far ahead

export function minutesSince(iso, now = Date.now()) {
  if (!iso) return null;
  const value = new Date(iso).getTime();
  if (!Number.isFinite(value)) return null;
  return Math.round((now - value) / 60000);
}

export function minutesUntil(iso, now = Date.now()) {
  const since = minutesSince(iso, now);
  return since === null ? null : -since;
}

export function span(min) {
  const m = Math.abs(Math.round(min));
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

export function tripExceptions(trips, now = Date.now()) {
  const out = [];
  for (const t of trips) {
    if (t.ride_status !== "requested" && t.ride_status !== "accepted" && t.ride_status !== "in_progress") continue;
    const scheduled = t.scheduled_pickup_at || null;
    const label = `Ride #${t.id}`;
    const who = t.rider_name || "Rider";

    if (!t.driver_name && (t.ride_status === "requested" || t.ride_status === "accepted")) {
      if (scheduled) {
        const until = minutesUntil(scheduled, now);
        if (until !== null && until <= PICKUP_WINDOW_MIN) {
          out.push({
            key: `nodriver-${t.id}`, tone: until <= 15 ? "critical" : "warning", rank: until,
            eyebrow: "Dispatch", title: `${label} has no driver`,
            meta: `${who} · pickup ${until < 0 ? `${span(until)} overdue` : `in ${span(until)}`}${t.flight_number ? ` · flight ${t.flight_number}` : ""}`,
            action: "Track ride", track: t.id,
          });
        }
      } else {
        const waited = minutesSince(t.created_at, now);
        if (waited !== null && waited >= ONDEMAND_WAIT_MIN) {
          out.push({
            key: `waiting-${t.id}`, tone: waited >= 15 ? "critical" : "warning", rank: -waited,
            eyebrow: "Dispatch", title: `${label} still waiting for a driver`,
            meta: `${who} · waiting ${span(waited)}`, action: "Track ride", track: t.id,
          });
        }
      }
    }

    // Only a position that has been reported and then went quiet counts. A driver app that never
    // reports location would otherwise raise this on every trip.
    if (t.driver_name && t.ride_status === "in_progress" && t.location_updated_at) {
      const silent = minutesSince(t.location_updated_at, now);
      if (silent !== null && silent >= GPS_SILENT_MIN) {
        out.push({
          key: `gps-${t.id}`, tone: "warning", rank: -silent,
          eyebrow: "Live trip", title: `${label}: driver location silent`,
          meta: `${t.driver_name} · last position ${span(silent)} ago`, action: "Track ride", track: t.id,
        });
      }
    }
  }
  return out;
}

export function upcomingAirport(trips, now = Date.now()) {
  return trips
    .filter((t) => t.flight_number && (t.ride_status === "requested" || t.ride_status === "accepted"))
    .map((t) => ({ trip: t, until: minutesUntil(t.scheduled_pickup_at || t.created_at, now) }))
    .filter((x) => x.until !== null && x.until <= AIRPORT_LOOKAHEAD_MIN)
    .sort((a, b) => a.until - b.until)
    .slice(0, 6);
}
