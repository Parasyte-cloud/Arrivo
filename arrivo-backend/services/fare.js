// Fare calculation — the one and only place fare math happens server-side.
//
// One-way (airport transfer) pricing is a flat, per-location price — NOT a
// distance/time formula. This replaced an earlier distance+duration formula
// (which used placeholder starting rates, never validated against real
// data) after real-world feedback: riders and partners wanted "a fee per
// location, that's it" rather than a metered fare that's hard to quote
// upfront. The AREA_PRICING table below is the same data originally sourced
// from the product's "Recommended Fixed Pricing" table (previously lived
// only in the website's local JS, disconnected from what actually got
// charged) — this is now the one real source both the website and apps
// price from.
//
// Multi-day charter bookings (Chauffeur/day-week-month) are unaffected —
// still a flat day-rate × duration, unrelated to this per-location system.

// Green zone — close to the airport, best roads, operate freely.
// Yellow zone — further out / heavier traffic corridors, priced higher per
// the PRD's "Recommended Fixed Pricing" table (which supersedes the
// earlier general range for these areas).
// Prices are the Standard Sedan base for that area; SUV/Executive add
// VEHICLE_TIER_DELTA_NAIRA on top (see below).
const AREA_PRICING = {
  // Green zone
  "ikeja gra": 27500, "maryland": 30000, "ogba": 30000, "magodo": 32500,
  "surulere": 32500, "yaba": 34500, "anthony": 30000, "anthony village": 30000,
  "ilupeju": 30000, "gbagada": 37500, "allen avenue": 30000, "alausa": 30000,
  "ajao estate": 30000, "victoria island": 45000, "ikoyi": 50000,
  "lekki phase 1": 45000,

  // Yellow zone — traffic corridors, Recommended Fixed Pricing table
  "iyana-ipaja": 47500, "iyana ipaja": 47500, "egbeda": 47500, "akowonjo": 47500,
  "idimu": 52500, "ipaja": 47500, "ayobo": 55000, "baruwa": 55000,
  "alimosho": 50000, "command": 57500, "abule egba": 55000,
  "ijaiye": 47500, "oko oba": 47500, "dopemu": 42500, "shasha": 50000,

  // Yellow zone — premium/distance pricing
  "lekki": 45000, "ajah": 55000, "ikorodu": 50000, "festac": 50000,
  "satellite town": 60000,
};

// Areas not explicitly listed above still need *some* price — rather than
// silently defaulting to the cheapest tier (which would underprice a
// genuinely far, just-not-yet-catalogued area), unmatched addresses fall
// back to this mid-range green-zone figure. If a specific area keeps
// hitting this fallback, it probably needs its own AREA_PRICING entry.
const DEFAULT_AREA_PRICE_NAIRA = 32000;

// Red zone — no operations, for now. Same list the apps/website already
// used client-side as a UX check; now also enforced here so it can't be
// bypassed by skipping the client-side check.
const EXCLUDED_AREAS = [
  { name: "Badagry", keywords: ["badagry"] },
  { name: "Epe", keywords: ["epe"] },
  { name: "Ibeju-Lekki", keywords: ["ibeju-lekki", "ibeju lekki"] },
  { name: "Makoko", keywords: ["makoko"] },
];

// RideArrivo one-way trips always involve the airport on one end — riders
// can book either "airport → their area" (the common case) or "their area →
// airport" (return trip), and pickup/destination are free text either way.
// The per-location price should always be about the NON-airport leg, so
// this detects which side is the airport and prices off the other one. If
// neither side matches (a pure point-to-point trip not involving the
// airport at all — not really this product's use case, but the fields
// don't hard-enforce it), destination is used, same convention as before.
const AIRPORT_KEYWORDS = ["airport", "murtala", "mmia", "mm2", "muhammed international"];

function matchesAny(address, keywords) {
  const a = " " + (address || "").toLowerCase() + " ";
  return keywords.some((k) => a.indexOf(k) !== -1);
}

function isAirportAddress(address) {
  return matchesAny(address, AIRPORT_KEYWORDS);
}

// Returns the matching EXCLUDED_AREAS entry, or null.
function findExcludedArea(address) {
  const a = " " + (address || "").toLowerCase() + " ";
  for (const area of EXCLUDED_AREAS) {
    if (area.keywords.some((k) => a.indexOf(k) !== -1)) return area;
  }
  return null;
}

function findAreaPrice(address) {
  const a = " " + (address || "").toLowerCase() + " ";
  let bestMatch = null;
  for (const key in AREA_PRICING) {
    if (a.indexOf(key) !== -1) {
      // Prefer the longest/most specific keyword match (e.g. "lekki phase
      // 1" over the more general "lekki") over whichever happens to be
      // checked first in object iteration order.
      if (!bestMatch || key.length > bestMatch.length) bestMatch = key;
    }
  }
  return bestMatch ? AREA_PRICING[bestMatch] : DEFAULT_AREA_PRICE_NAIRA;
}

// Vehicle tier delta — the area's base (Standard Sedan) price plus a fixed
// delta per tier, matching the "from ₦X / ₦X+15k / ₦X+30k" spacing given
// for Standard Sedan / Premium SUV / Executive Vehicle — a flat +15k / +30k
// rather than re-deriving a per-area number for every vehicle type across
// 30+ areas.
//
// "pickup" (Pickup Truck) is a separate, later addition for heavy/bulky
// cargo — distinct from "truck" (which is actually the Executive Vehicle
// premium tier, a historical naming choice kept as-is to avoid a wider
// rename). Priced between Sedan and Premium SUV rather than at/above
// Executive: it's a working cargo vehicle, not a luxury one, so it
// shouldn't cost more than the passenger-comfort tiers above it.
const VEHICLE_TIER_DELTA_NAIRA = { sedan: 0, suv: 15000, truck: 30000, pickup: 10000 };

// Higher all-in night price, 8pm–5am — NOT a separate itemized surcharge
// line (the product decision here was explicitly "one fee per location,
// no more fees"), just a higher total for the same location during those
// hours. Computed in Africa/Lagos time (UTC+1) regardless of what timezone
// the server itself runs in, so this doesn't silently shift if Render's
// underlying host clock is UTC.
const NIGHT_MULTIPLIER = 1.2;
const NIGHT_START_HOUR = 20; // 8pm
const NIGHT_END_HOUR = 5; // 5am

function isLagosNightTime(date = new Date()) {
  // Africa/Lagos is a fixed UTC+1 offset (no DST), so this is safe without
  // pulling in a timezone library.
  const lagosHour = (date.getUTCHours() + 1) % 24;
  return lagosHour >= NIGHT_START_HOUR || lagosHour < NIGHT_END_HOUR;
}

const ROUND_TO_NAIRA = 500;

function roundUpToNearest(amount, step) {
  return Math.ceil(amount / step) * step;
}

// Multi-day charter bookings (Chauffeur screen) aren't priced per-location
// at all — a week-long booking is a flat day-rate times duration, same
// model the app already used. Untouched by the one-way pricing change
// above.
const CHARTER_FLAT_BASE_NAIRA = { sedan: 8500, suv: 12500, truck: 16000, pickup: 11000 };
const CHARTER_MULTIPLIER = { full_day: 6, full_week: 30, full_month: 100 };

// A rider booking 'full_day' can ask for any number of consecutive full
// days (e.g. a 3-day, an 18-day, or a 78-day chauffeur booking) instead of
// only ever a single day — the day count (duration_days on the ride) is
// multiplied straight into the charge, uncapped from the rider's
// perspective. MAX_FULL_DAY_COUNT below is not a pricing ceiling, just a
// server-side sanity bound to reject obviously-bad input (typos, abuse),
// set generously high so it never gets in the way of a real booking.
// full_week/full_month stay flat packages, unaffected — they aren't priced
// "per day" the same way full_day is.
const MAX_FULL_DAY_COUNT = 365;

// Priced in USD so it doesn't silently drift in real terms as the
// naira/dollar rate moves — converted at quote/booking time using whatever
// services/fx.js currently reports.
const SECURITY_ESCORT_PRICE_USD = 100;
const FLEET_PRICE_NAIRA = { 2: 70000, 3: 100000 };

// Flat payout to a fleet-escort companion driver per completed convoy trip
// (business decision, July 2026) — separate from the rider-facing
// FLEET_PRICE_NAIRA surcharge above, which the primary ride's driver never
// shared with escort drivers. Priced in USD like the other flat add-ons
// here, converted to naira at completion time. Paid out regardless of how
// many escort vehicles were in the convoy — each companion driver gets the
// same flat $100 for their own leg of it.
const FLEET_ESCORT_PAYOUT_USD = 100;

// How many passengers each vehicle type actually seats — mirrors the
// identical MAX_PASSENGERS map kept client-side in both apps' booking
// screens and the website's booking.js. Duplicated here (not imported from
// anywhere shared) so vehicleCount below is independently re-derived
// server-side from passengerCount, never trusted from whatever a client
// sends — same "never trust the client with money-relevant numbers"
// principle as every other number in this file. "pickup" (Pickup Truck)
// seats fewer than SUV/Executive since the bed is for cargo, not people.
const MAX_PASSENGERS = { sedan: 3, suv: 5, truck: 5, pickup: 3 };

// A group bigger than a single vehicle holds no longer blocks the booking —
// it books enough of the SAME vehicle type to fit everyone instead, and the
// fare below scales with that count. Capped well short of "no driver could
// realistically staff this many vehicles for one trip at once": past
// MAX_AUTO_VEHICLE_COUNT vehicles, riders are asked to contact RideArrivo
// directly to arrange a larger group/convoy booking rather than the app
// silently promising an arbitrarily large one.
const MAX_AUTO_VEHICLE_COUNT = 6;

// Given how many people are riding and which vehicle type they picked,
// works out how many of that vehicle are actually needed to fit everyone —
// e.g. 8 passengers in a 5-seat SUV needs 2 SUVs. Throws (same pattern as
// findExcludedArea's caller) if that would take more vehicles than
// MAX_AUTO_VEHICLE_COUNT, so a huge, unrealistic group gets a clear message
// instead of a silently-accepted booking nobody can actually fulfill.
function computeVehicleCount(passengerCount, vehicleType) {
  const capacity = MAX_PASSENGERS[vehicleType] || 1;
  const count = Math.max(1, Math.ceil((Number(passengerCount) || 1) / capacity));
  if (count > MAX_AUTO_VEHICLE_COUNT) {
    throw new Error(
      `${passengerCount} passengers is more than we can automatically match to vehicles (up to ${MAX_AUTO_VEHICLE_COUNT} × ${vehicleType}, ${MAX_AUTO_VEHICLE_COUNT * capacity} people max). Please contact RideArrivo directly to arrange a larger group booking.`
    );
  }
  return count;
}

// "Luxury" toggle — a flat surcharge on top of the normal per-location
// (one-way) or flat-rate (charter) fare, for a rider who wants a nicer
// Sedan/SUV without switching to the Executive tier. Priced in USD per the
// business decision behind it ("luxurious suv's $100"), converted to naira
// at whatever the current FX rate is (services/fx.js) at quote/booking
// time. Executive/truck has no luxury option: it's already the premium tier.
// Pickup Truck has no luxury option either: it's a cargo vehicle, not a
// comfort tier.
const LUXURY_SURCHARGE_USD = { sedan: 60, suv: 100 };

// pickupAddress/destinationAddress are the free-text addresses the rider
// entered (or picked via autocomplete) — these, not lat/lng, are what
// determine price now. lat/lng are still collected by the apps/website for
// maps and live tracking, but no longer feed the fare calculation.
function computeOneWayFare({ pickupAddress, destinationAddress, vehicleType }) {
  const excluded = findExcludedArea(destinationAddress) || findExcludedArea(pickupAddress);
  if (excluded) {
    throw new Error(`RideArrivo doesn't currently operate in ${excluded.name}.`);
  }

  const zoneAddress = isAirportAddress(destinationAddress) ? pickupAddress : destinationAddress;
  const vehicleDelta = VEHICLE_TIER_DELTA_NAIRA[vehicleType] || 0;
  let total = findAreaPrice(zoneAddress) + vehicleDelta;

  if (isLagosNightTime()) {
    total = total * NIGHT_MULTIPLIER;
  }

  return roundUpToNearest(total, ROUND_TO_NAIRA);
}

function computeCharterFare({ vehicleType, bookingType, durationDays }) {
  const multiplier = CHARTER_MULTIPLIER[bookingType];
  if (!multiplier) throw new Error(`computeCharterFare: unknown bookingType '${bookingType}'`);
  // Only 'full_day' scales linearly with an explicit day count — a rider
  // entering "18 days" pays exactly 18x a single full day, any value up to
  // the sanity bound (MAX_FULL_DAY_COUNT above). full_week/full_month are
  // already fixed multi-day packages, so durationDays is ignored for those
  // regardless of what a client sends.
  const dayCount = bookingType === "full_day" ? Math.min(Math.max(Number(durationDays) || 1, 1), MAX_FULL_DAY_COUNT) : 1;
  return (CHARTER_FLAT_BASE_NAIRA[vehicleType] || 0) * multiplier * dayCount;
}

// Shared by the /quote endpoint (rider is just previewing) and ride
// creation (which must independently re-verify, never trust the client's
// number). securityEscort/fleetSize add-ons apply the same way regardless
// of booking type. luxury only applies to sedan/suv (see
// LUXURY_SURCHARGE_USD above) — silently ignored for any other vehicle
// type rather than erroring, since the client just wouldn't offer the
// toggle for those.
// passengerCount drives vehicleCount (see computeVehicleCount above) — a
// group too big for one vehicle is charged for as many of that same
// vehicle type as it takes to fit everyone (base fare AND luxury surcharge
// scale with vehicleCount; securityEscort/fleetSize don't, since those are
// a flat escort/convoy arrangement, not per transport vehicle). Defaults to
// 1 so every existing caller that doesn't pass it (charter bookings that
// never collected a passenger count) is unaffected.
// ngnPerUsd must be passed in by the caller (from services/fx.js) rather
// than fetched in here, so this function stays a pure/sync calculation —
// easy to unit-test and to call from a request handler that already has
// the rate cached.
async function computeFare({ bookingType, pickupAddress, destinationAddress, vehicleType, securityEscort, fleetSize, luxury, ngnPerUsd, durationDays, passengerCount = 1 }) {
  // 'dropoff' (Airport Drop-off — departing rider, pickup → airport) is
  // priced with the exact same per-location formula as 'one_way' (arriving
  // rider, airport → destination) — computeOneWayFare already prices off
  // whichever leg ISN'T the airport, so it's direction-agnostic by design.
  const base =
    bookingType === "one_way" || bookingType === "dropoff"
      ? computeOneWayFare({ pickupAddress, destinationAddress, vehicleType })
      : computeCharterFare({ vehicleType, bookingType, durationDays });

  const vehicleCount = computeVehicleCount(passengerCount, vehicleType);

  let total = base * vehicleCount;
  if (luxury && LUXURY_SURCHARGE_USD[vehicleType]) {
    total += LUXURY_SURCHARGE_USD[vehicleType] * ngnPerUsd * vehicleCount;
  }
  if (securityEscort) total += SECURITY_ESCORT_PRICE_USD * ngnPerUsd;
  if (fleetSize) total += FLEET_PRICE_NAIRA[fleetSize] || 0;
  return Math.round(total);
}

// ── Chauffeur time-overage ──
// Scoped to single-day 'full_day' bookings only (see the schema.sql comment
// on rides.included_hours_per_day for why one-way and multi-day charters are
// excluded). The per-day flat rate doesn't actually vary with how many
// hours a rider selects at booking (a 4-hour and a 10-hour single-day
// booking cost the same CHARTER_FLAT_BASE_NAIRA*6) — so rather than invent
// a separate, disconnected per-hour rate table, the hourly overage rate is
// derived FROM the day rate the rider already paid, divided by the hours
// THEY selected as included. That keeps the rate consistent with what they
// actually agreed to pay per hour, whatever number of hours they picked.
const OVERAGE_GRACE_HOURS = 0.5; // small buffer so arriving a few minutes late to end the trip never triggers a charge
const MAX_OVERAGE_MULTIPLE_OF_FARE = 2; // sanity cap — protects against a driver forgetting to mark a trip complete for hours/days

function computeOverageNaira({ vehicleType, includedHoursPerDay, elapsedHours, fareNaira }) {
  if (!includedHoursPerDay || includedHoursPerDay <= 0) return 0;
  const overageHours = elapsedHours - includedHoursPerDay - OVERAGE_GRACE_HOURS;
  if (overageHours <= 0) return 0;

  const dayRateNaira = (CHARTER_FLAT_BASE_NAIRA[vehicleType] || 0) * (CHARTER_MULTIPLIER.full_day || 0);
  const perHourNaira = dayRateNaira / includedHoursPerDay;

  const rawOverage = roundUpToNearest(perHourNaira * overageHours, ROUND_TO_NAIRA);
  const cap = Math.round((fareNaira || 0) * MAX_OVERAGE_MULTIPLE_OF_FARE);
  return cap > 0 ? Math.min(rawOverage, cap) : rawOverage;
}

module.exports = {
  computeFare,
  computeOneWayFare,
  computeCharterFare,
  computeVehicleCount,
  computeOverageNaira,
  findExcludedArea,
  findAreaPrice,
  isAirportAddress,
  isLagosNightTime,
  SECURITY_ESCORT_PRICE_USD,
  FLEET_PRICE_NAIRA,
  FLEET_ESCORT_PAYOUT_USD,
  VEHICLE_TIER_DELTA_NAIRA,
  LUXURY_SURCHARGE_USD,
  AREA_PRICING,
  DEFAULT_AREA_PRICE_NAIRA,
  EXCLUDED_AREAS,
  NIGHT_MULTIPLIER,
  MAX_FULL_DAY_COUNT,
  MAX_PASSENGERS,
  MAX_AUTO_VEHICLE_COUNT,
  OVERAGE_GRACE_HOURS,
  MAX_OVERAGE_MULTIPLE_OF_FARE,
};
