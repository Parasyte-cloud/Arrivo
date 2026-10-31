// One lookup for everything that needs a flight: ride creation, the reminder sweep and the Ops
// tracker. FlightAware first (it also gives the plane's position), AviationStack as the backup,
// the same order the Ops console already used. Before this, the scheduler and booking only
// asked AviationStack, so with only FlightAware configured no reminder ever fired.
//
// It never throws and never guesses. The answer is always { state, label, reason, flight }, and
// "unknown" is a real answer that Ops can see.
//
// direction "arrival" is a rider landing at the airport (pickup). "departure" is a rider flying
// out of it (drop-off): the airport filter then applies to where the flight leaves from. The old
// code filtered departing flights by arrival airport, so a drop-off flight was never found.
const input = require("./flightInput");
const flightAware = require("./flightAware");

function providers() {
  const list = [];
  if (flightAware.isConfigured()) list.push(["flightaware", (n, a, o) => flightAware.lookupFlightAware(n, a, o)]);
  const key = process.env.AVIATIONSTACK_KEY;
  if (key && key !== "replace_me") list.push(["aviationstack", (n, a, o) => require("../routes/flights").lookupFlightStatus(n, a, o)]);
  return list;
}

// Lookups are paid and quota-limited. One flight and day is asked about at most once per window,
// shorter while the plane is in the air. Failures are never cached.
const cache = new Map();
const TTL_MS = 5 * 60 * 1000;
const TTL_LIVE_MS = 90 * 1000;

async function lookupFlight({ flightNumber, date = null, airport = "LOS", direction = "arrival", couldBePnr = false, now = new Date(), _providers = null }) {
  const parsed = input.normalizeFlightNumber(flightNumber);
  if (!parsed.ok) {
    return { ...input.describeTracking({ ident: parsed.reason === "empty" ? null : "?", flight: null, couldBePnr: parsed.reason === "pnr_like", now }), ident: null, flight: null };
  }
  const list = _providers || providers();
  if (!list.length) return { state: "unknown", label: "Flight status unavailable", reason: "no_provider", ident: parsed.ident, flight: null };

  const cacheKey = `${direction}|${airport}|${parsed.ident}|${date || ""}`;
  if (!_providers) {
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.at < hit.ttl) return hit.value;
  }

  const timeOf = (f) => (direction === "departure" ? f.departure?.scheduled : f.arrival?.estimated || f.arrival?.scheduled);
  let flight = null;
  let failed = false;
  for (const [name, run] of list) {
    try {
      const found = direction === "departure"
        ? await run(parsed.ident, null, { date, depIata: airport })
        : await run(parsed.ident, airport, { date });
      if (!found) continue;
      // A different day's instance of the same number is not this rider's flight.
      if (date && timeOf(found) && input.lagosDay(timeOf(found)) !== date) continue;
      flight = { ...found, provider: found.provider || name };
      break;
    } catch (err) {
      failed = true;
      console.error(`[flight] ${name} lookup failed:`, err.response?.data?.error || err.message);
    }
  }
  const result = {
    ...input.describeTracking({
      ident: parsed.ident, date, flight, direction, providerError: !flight && failed,
      couldBePnr: couldBePnr || input.couldAlsoBePnr(flightNumber), now,
    }),
    ident: parsed.ident,
    flight,
  };
  if (!_providers && !(result.state === "unknown" && result.reason === "provider_error")) {
    cache.set(cacheKey, { at: Date.now(), ttl: flight?.position ? TTL_LIVE_MS : TTL_MS, value: result });
  }
  return result;
}

module.exports = { lookupFlight };
