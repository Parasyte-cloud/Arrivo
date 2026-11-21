// Live flight status and position from FlightAware AeroAPI (https://flightaware.com/aeroapi).
// Optional: only used when FLIGHTAWARE_API_KEY is set. Returns the same shape as
// routes/flights.js lookupFlightStatus, plus `position` while the plane is in the air.
// Returns null when the flight is not found. Throws on a bad key or a provider error.
const axios = require("axios");

const BASE = "https://aeroapi.flightaware.com/aeroapi";

// Where the flight lands. Coordinates are only needed to draw the route, so a short list of the
// Nigerian airports is enough. The departure point is read from the first point of the flown track.
const AIRPORTS = {
  LOS: { name: "Lagos", lat: 6.5774, lng: 3.3212 },
  ABV: { name: "Abuja", lat: 9.0068, lng: 7.2632 },
  PHC: { name: "Port Harcourt", lat: 5.0155, lng: 6.9496 },
  KAN: { name: "Kano", lat: 12.0476, lng: 8.5246 },
  ENU: { name: "Enugu", lat: 6.4743, lng: 7.5619 },
  QOW: { name: "Owerri", lat: 5.4276, lng: 7.2061 },
  BNI: { name: "Benin City", lat: 6.3170, lng: 5.5995 },
  QRW: { name: "Warri", lat: 5.5961, lng: 5.8178 },
  ILR: { name: "Ilorin", lat: 8.4402, lng: 4.4939 },
  JOS: { name: "Jos", lat: 9.6398, lng: 8.8693 },
};

// At most `max` points, always keeping the first and the last.
function thin(points, max = 120) {
  if (points.length <= max) return points;
  const out = [];
  const step = (points.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(points[Math.round(i * step)]);
  return out;
}

const isConfigured = () => Boolean(process.env.FLIGHTAWARE_API_KEY) && process.env.FLIGHTAWARE_API_KEY !== "replace_me";

const iso = (v) => (v ? new Date(v).toISOString() : undefined);

// One ident can match several days of the same flight. Prefer the one in the air, then the
// one closest to now, and ignore cancelled ones when anything else exists.
function pickFlight(flights) {
  if (!flights?.length) return null;
  const now = Date.now();
  const live = flights.find((f) => f.actual_off && !f.actual_in && !f.cancelled);
  if (live) return live;
  const usable = flights.filter((f) => !f.cancelled);
  const pool = usable.length ? usable : flights;
  const when = (f) => new Date(f.estimated_in || f.scheduled_in || f.scheduled_out || now).getTime();
  return [...pool].sort((a, b) => Math.abs(when(a) - now) - Math.abs(when(b) - now))[0];
}

function mapStatus(f) {
  if (f.cancelled) return "cancelled";
  if (f.diverted) return "diverted";
  if (f.actual_in) return "landed";
  if (f.actual_off) return "active";
  return "scheduled";
}

async function lookupFlightAware(flightNumber, arrIata = "LOS", opts = {}) {
  if (!isConfigured() || !flightNumber) return null;
  const ident = String(flightNumber).trim().toUpperCase();
  if (!ident) return null;
  const headers = { "x-apikey": process.env.FLIGHTAWARE_API_KEY };

  // With a flight date (the rider's day of arrival, Lagos time) the window is that day, so a
  // booking for tomorrow never picks up today's instance of the same flight number. Without
  // one it is a window around now: yesterday to two days ahead, as before.
  const win = opts.date ? require("./flightInput").flightWindow(opts.date) : null;
  const start = win ? win.start : new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const end = win ? win.end : new Date(Date.now() + 48 * 3600 * 1000).toISOString();
  const { data } = await axios.get(`${BASE}/flights/${encodeURIComponent(ident)}`, {
    headers, timeout: 8000, params: { start, end, max_pages: 1 },
  });
  const flights = (data?.flights || []).filter((f) => !arrIata || !f.destination?.code_iata || f.destination.code_iata === arrIata);
  const f = pickFlight(flights.length ? flights : data?.flights);
  if (!f) return null;

  const status = mapStatus(f);
  let position = null;
  if (status === "active" && f.fa_flight_id) {
    try {
      const pos = await axios.get(`${BASE}/flights/${encodeURIComponent(f.fa_flight_id)}/position`, { headers, timeout: 8000 });
      const p = pos.data?.last_position || pos.data;
      if (p && typeof p.latitude === "number" && typeof p.longitude === "number") {
        position = {
          lat: p.latitude,
          lng: p.longitude,
          heading: typeof p.heading === "number" ? p.heading : 0,
          // FlightAware reports altitude in hundreds of feet and speed in knots.
          altitudeFt: typeof p.altitude === "number" ? p.altitude * 100 : null,
          speedKmh: typeof p.groundspeed === "number" ? Math.round(p.groundspeed * 1.852) : null,
          updatedAt: iso(p.timestamp),
        };
      }
    } catch { /* the status is still useful without a position */ }
  }

  // The path flown so far, for the flight map. One extra query, only while the plane is in the air.
  let track = null;
  if (status === "active" && f.fa_flight_id) {
    try {
      const t = await axios.get(`${BASE}/flights/${encodeURIComponent(f.fa_flight_id)}/track`, { headers, timeout: 8000 });
      const pts = (t.data?.positions || [])
        .filter((p) => typeof p.latitude === "number" && typeof p.longitude === "number")
        .map((p) => [Number(p.latitude.toFixed(4)), Number(p.longitude.toFixed(4))]);
      if (pts.length > 1) track = thin(pts);
    } catch { /* the plane marker still works without the flown path */ }
  }
  const destCode = f.destination?.code_iata || arrIata;
  const destination = AIRPORTS[destCode] ? { code: destCode, ...AIRPORTS[destCode] } : null;
  const origin = track ? { code: f.origin?.code_iata || f.origin?.code, name: f.origin?.city || f.origin?.name, lat: track[0][0], lng: track[0][1] } : null;

  return {
    provider: "flightaware",
    aircraft: f.aircraft_type || null,
    track,
    origin,
    destination,
    flightNumber: f.ident_iata || f.ident,
    airline: f.operator || undefined,
    status,
    progressPercent: typeof f.progress_percent === "number" ? f.progress_percent : null,
    departure: {
      airport: f.origin?.name || f.origin?.code_iata || f.origin?.code,
      scheduled: iso(f.scheduled_out || f.scheduled_off),
    },
    arrival: {
      airport: f.destination?.name || f.destination?.code_iata,
      scheduled: iso(f.scheduled_in),
      estimated: iso(f.actual_in || f.estimated_in),
      terminal: f.terminal_destination || undefined,
      gate: f.gate_destination || undefined,
    },
    position,
  };
}

module.exports = { lookupFlightAware, isConfigured, pickFlight, mapStatus, thin, AIRPORTS };
