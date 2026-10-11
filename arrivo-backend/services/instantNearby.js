// "How many drivers are close, and how soon can one reach me?" for the
// ArrivoExpress vehicle picker.
//
// This is a READ-ONLY look at the same driver pool dispatch draws from (same
// verified / online / opted-in / fresh-GPS / not-on-a-ride rules as
// findEligibleDrivers in instantDispatch.js), with no row locks and no offers
// created. It is an estimate for display only: nothing is promised to the
// rider, and booking still goes through the normal dispatch path.

const { listTiers } = require("./instantTiers");

// Beyond this a "pickup time" stops being useful to show.
const NEARBY_RADIUS_KM = 8;

// Lagos urban average. Deliberately conservative so the ETA we show is more
// often early than late. Tunable without a deploy.
function etaSpeedKmh() {
  const v = Number(process.env.ARRIVO_NOW_ETA_SPEED_KMH);
  return Number.isFinite(v) && v >= 5 && v <= 80 ? v : 20;
}

function etaMinutesForDistance(distanceKm) {
  const km = Number(distanceKm);
  if (!Number.isFinite(km) || km < 0) return null;
  // +1 minute for the driver to accept and pull out; never promise under 2.
  return Math.max(2, Math.ceil((km / etaSpeedKmh()) * 60) + 1);
}

// Pure: driver rows ({ vehicle_type, seats, distance_to_pickup_km }) in,
// per-tier availability out. Tiers with no one nearby report drivers: 0 and
// etaMin: null so the client can say "No cars nearby" honestly.
function summarizeNearby(rows, tiers = listTiers()) {
  const out = {};
  for (const tier of tiers) {
    const matching = rows.filter(
      (r) =>
        (!tier.vehicleType || r.vehicle_type === tier.vehicleType) &&
        (Number(r.seats) || 1) >= (tier.minSeats || 1)
    );
    const nearest = matching.reduce(
      (min, r) => Math.min(min, Number(r.distance_to_pickup_km)),
      Infinity
    );
    out[tier.key] = {
      drivers: matching.length,
      etaMin: matching.length ? etaMinutesForDistance(nearest) : null,
    };
  }
  return out;
}

async function estimateNearbyDrivers({ lat, lng, db }) {
  // Loaded here so the pure helpers above can be unit tested without a database.
  if (!db) db = require("../db/db").pool;
  const maxAge = Number(process.env.ARRIVO_NOW_LOCATION_MAX_AGE_SECONDS);
  const locationMaxAgeSeconds =
    Number.isFinite(maxAge) && maxAge >= 10 && maxAge <= 300 ? maxAge : 45;

  const result = await db.query(
    `SELECT v.vehicle_type,
            v.seats,
            6371.0 * acos(LEAST(1.0, GREATEST(-1.0,
              cos(radians($1::double precision)) * cos(radians(d.current_lat))
              * cos(radians(d.current_lng) - radians($2::double precision))
              + sin(radians($1::double precision)) * sin(radians(d.current_lat))
            ))) AS distance_to_pickup_km
       FROM drivers d
       JOIN vehicles v ON v.id = d.vehicle_id
      WHERE d.is_verified = true
        AND d.is_online = true
        AND d.accepts_instant = true
        AND d.current_lat IS NOT NULL
        AND d.current_lng IS NOT NULL
        AND d.location_updated_at >= now() - ($3::int * interval '1 second')
        AND NOT EXISTS (
          SELECT 1 FROM rides r
           WHERE r.driver_id = d.id
             AND r.ride_status IN ('accepted', 'in_progress')
        )
      ORDER BY distance_to_pickup_km ASC
      LIMIT 60`,
    [lat, lng, locationMaxAgeSeconds]
  );

  const nearby = result.rows.filter(
    (r) => Number(r.distance_to_pickup_km) <= NEARBY_RADIUS_KM
  );
  return summarizeNearby(nearby);
}

module.exports = {
  NEARBY_RADIUS_KM,
  etaMinutesForDistance,
  summarizeNearby,
  estimateNearbyDrivers,
};
