// Live flight status and position from FlightAware AeroAPI (https://flightaware.com/aeroapi).
// Optional: only used when FLIGHTAWARE_API_KEY is set. Returns the same shape as
// routes/flights.js lookupFlightStatus, plus `position` while the plane is in the air.
// Returns null when the flight is not found. Throws on a bad key or a provider error.
const axios = require("axios");

const BASE = "https://aeroapi.flightaware.com/aeroapi";

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

async function lookupFlightAware(flightNumber, arrIata = "LOS") {
  if (!isConfigured() || !flightNumber) return null;
  const ident = String(flightNumber).trim().toUpperCase();
  if (!ident) return null;
  const headers = { "x-apikey": process.env.FLIGHTAWARE_API_KEY };

  // A window around now: yesterday to two days ahead, so tonight's and tomorrow's arrivals are found.
  const start = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const end = new Date(Date.now() + 48 * 3600 * 1000).toISOString();
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

  return {
    provider: "flightaware",
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

module.exports = { lookupFlightAware, isConfigured, pickFlight, mapStatus };
