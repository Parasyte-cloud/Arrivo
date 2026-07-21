// Fare calculation — the one and only place fare math happens server-side.
// Replaces the old approach (a hardcoded keyword-matching price table
// against whatever address text the rider typed) with a real formula
// driven by actual driving distance/duration from Google's Distance
// Matrix API. Every rate below is a business decision, not a technical
// one — these are reasonable starting points, not researched-and-proven
// numbers. Tune them to your actual unit economics (driver payout %,
// fuel, vehicle upkeep) once you have real trip data to look at.
//
// Positioning: RideArrivo is a premium airport-transfer service, not a
// commodity ride-hailing app, so fares lean a little higher than a plain
// per-km taxi rate would — that's the "stylishly spendy" part. The
// ROUND_TO_NAIRA step rounds every quote up to a clean number (nearest
// 500) so prices read as deliberate rather than an odd calculated total.

const ONE_WAY = {
  BASE_FARE_NAIRA: 15000, // covers dispatch + airport meet-and-greet, charged regardless of distance
  PER_KM_NAIRA: 600, // real driving distance, from Google Distance Matrix
  PER_MINUTE_NAIRA: 60, // accounts for Lagos traffic — a slow 10km trip costs more than a fast one
  ROUND_TO_NAIRA: 500,
};

// Vehicle tier delta — added on top of the distance-based fare above, so
// an SUV/Executive vehicle still costs progressively more than a Sedan on
// longer trips, not just at the floor.
const VEHICLE_TIER_DELTA_NAIRA = { sedan: 0, suv: 15000, truck: 30000 };

// Per-vehicle floor for a one-way trip, even a very short one — explicit
// business numbers ("leave the suv's at 35,000.00 and sedan at 25,000").
// These only bite on short trips — a long enough trip will naturally price
// above its vehicle's floor from the distance/time math + delta alone.
const VEHICLE_MIN_FARE_NAIRA = { sedan: 25000, suv: 35000, truck: 50000 };

// Multi-day charter bookings (Chauffeur screen) aren't priced by distance
// at all — a week-long booking isn't "one big trip," it's a flat day-rate
// times duration, same model the app already used. Left untouched here,
// just centralized server-side so it can be verified rather than trusted
// from the client.
const CHARTER_FLAT_BASE_NAIRA = { sedan: 8500, suv: 12500, truck: 16000 };
const CHARTER_MULTIPLIER = { full_day: 6, full_week: 30, full_month: 100 };

// Priced in USD, like the luxury surcharge above, so it doesn't silently
// drift in real terms as the naira/dollar rate moves — converted at
// quote/booking time using whatever services/fx.js currently reports.
const SECURITY_ESCORT_PRICE_USD = 100;
const FLEET_PRICE_NAIRA = { 2: 70000, 3: 100000 };

// "Luxury" toggle — a flat surcharge on top of the normal distance-based
// (one-way) or flat-rate (charter) fare, for a rider who wants a nicer
// Sedan/SUV without switching to the Executive tier. Priced in USD per the
// business decision behind it ("luxurious suv's $100"), converted to naira
// at whatever the current FX rate is (services/fx.js) at quote/booking
// time — never hardcoded in naira, since a fixed-naira surcharge would
// silently drift in real dollar terms as the exchange rate moves.
// Executive/truck has no luxury option: it's already the premium tier.
const LUXURY_SURCHARGE_USD = { sedan: 60, suv: 100 };

function roundUpToNearest(amount, step) {
  return Math.ceil(amount / step) * step;
}

// distanceKm/durationMin should come from Google's Distance Matrix API
// (see services/googleMaps.js) — never from the client.
function computeOneWayFare({ distanceKm, durationMin, vehicleType }) {
  if (!(distanceKm >= 0) || !(durationMin >= 0)) {
    throw new Error("computeOneWayFare requires a real distanceKm and durationMin");
  }
  const vehicleDelta = VEHICLE_TIER_DELTA_NAIRA[vehicleType] || 0;
  const raw =
    ONE_WAY.BASE_FARE_NAIRA +
    ONE_WAY.PER_KM_NAIRA * distanceKm +
    ONE_WAY.PER_MINUTE_NAIRA * durationMin +
    vehicleDelta;
  const minFare = VEHICLE_MIN_FARE_NAIRA[vehicleType] || VEHICLE_MIN_FARE_NAIRA.sedan;
  const floored = Math.max(raw, minFare);
  return roundUpToNearest(floored, ONE_WAY.ROUND_TO_NAIRA);
}

function computeCharterFare({ vehicleType, bookingType }) {
  const multiplier = CHARTER_MULTIPLIER[bookingType];
  if (!multiplier) throw new Error(`computeCharterFare: unknown bookingType '${bookingType}'`);
  return (CHARTER_FLAT_BASE_NAIRA[vehicleType] || 0) * multiplier;
}

// Shared by the /quote endpoint (rider is just previewing) and ride
// creation (which must independently re-verify, never trust the client's
// number). securityEscort/fleetSize add-ons apply the same way regardless
// of booking type. luxury only applies to sedan/suv (see
// LUXURY_SURCHARGE_USD above) — silently ignored for any other vehicle
// type rather than erroring, since the client just wouldn't offer the
// toggle for those.
// ngnPerUsd must be passed in by the caller (from services/fx.js) rather
// than fetched in here, so this function stays a pure/sync calculation —
// easy to unit-test and to call from a request handler that already has
// the rate cached.
async function computeFare({ bookingType, distanceKm, durationMin, vehicleType, securityEscort, fleetSize, luxury, ngnPerUsd }) {
  const base =
    bookingType === "one_way"
      ? computeOneWayFare({ distanceKm, durationMin, vehicleType })
      : computeCharterFare({ vehicleType, bookingType });

  let total = base;
  if (luxury && LUXURY_SURCHARGE_USD[vehicleType]) {
    total += LUXURY_SURCHARGE_USD[vehicleType] * ngnPerUsd;
  }
  if (securityEscort) total += SECURITY_ESCORT_PRICE_USD * ngnPerUsd;
  if (fleetSize) total += FLEET_PRICE_NAIRA[fleetSize] || 0;
  return Math.round(total);
}

module.exports = {
  computeFare,
  computeOneWayFare,
  computeCharterFare,
  SECURITY_ESCORT_PRICE_USD,
  FLEET_PRICE_NAIRA,
  VEHICLE_TIER_DELTA_NAIRA,
  VEHICLE_MIN_FARE_NAIRA,
  LUXURY_SURCHARGE_USD,
};
