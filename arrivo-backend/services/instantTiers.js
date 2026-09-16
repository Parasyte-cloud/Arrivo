// ArrivoExpress rider-facing vehicle tiers — the "pick your vehicle" step of
// on-demand booking. Each tier maps onto the SAME vehicles/vehicle_type
// data RideArrivo's scheduled bookings already use (see db/schema.sql and
// services/fare.js) — there is no separate ArrivoExpress fleet.
//
// XL is the one tier that is not a distinct vehicle_type: it is an SUV
// with enough seats (vehicles.seats) to actually carry more people than a
// standard Comfort SUV, using a column that already existed on `vehicles`
// but was not previously filtered on for matching — see minSeats handling
// in services/instantDispatch.js findEligibleDrivers.
//
// Pricing knobs here are ArrivoExpress-specific (see services/instantFare.js)
// and deliberately separate from services/fare.js's flat airport-transfer
// pricing table — ArrivoExpress is metered point-to-point, not a fixed price
// per named neighbourhood, since neither trip endpoint is reliably the
// airport the way RideArrivo's core product assumes.
//
// PRICING NOTE (updated 2026-09-16): baseFareNaira / perKmNaira /
// perMinNaira / minimumFareNaira below replace the original launch
// placeholders. Set Bolt-adjacent-plus-a-small-premium: Bolt Lagos runs
// roughly base 350 / 95 per km / 15 per min / 500 minimum for its
// Standard tier (with Comfort/XL layered on top at +20%/+35%), and Uber
// runs noticeably higher (base 450 / 120 per km / 20 per min / 600
// minimum for UberX). Bolt is the actual day-to-day competitor here, not
// Uber and not inDrive's negotiated pricing (see
// claude/arrivoexpress-competitive-strategy.md — deliberately not racing
// inDrive to the bottom), so these land just above Bolt rather than
// matching Uber. Still needs a check against real driver fuel/maintenance
// payout economics before ArrivoExpress leaves the ARRIVO_NOW_ENABLED=false
// rollout gate — this is a market-rate pass, not a driver-economics pass.
const ARRIVONOW_TIERS = {
  economy: {
    key: "economy",
    label: "Economy",
    description: "Everyday sedan rides — the most affordable ArrivoExpress tier.",
    vehicleType: "sedan",
    minSeats: 1,
    baseFareNaira: 400,
    perKmNaira: 110,
    perMinNaira: 18,
    minimumFareNaira: 600,
  },
  comfort: {
    key: "comfort",
    label: "Comfort",
    description: "Newer SUVs with more legroom and boot space.",
    vehicleType: "suv",
    minSeats: 1,
    baseFareNaira: 550,
    perKmNaira: 140,
    perMinNaira: 22,
    minimumFareNaira: 900,
  },
  xl: {
    key: "xl",
    label: "XL",
    description: "6+ seat SUVs for groups and extra luggage.",
    vehicleType: "suv",
    minSeats: 6,
    baseFareNaira: 650,
    perKmNaira: 160,
    perMinNaira: 25,
    minimumFareNaira: 1200,
  },
  premium: {
    key: "premium",
    label: "Premium",
    description: "RideArrivo's Executive fleet, chauffeur-grade comfort on demand.",
    vehicleType: "truck",
    minSeats: 1,
    baseFareNaira: 900,
    perKmNaira: 220,
    perMinNaira: 30,
    minimumFareNaira: 1800,
  },
};

const ARRIVONOW_TIER_ORDER = ["economy", "comfort", "xl", "premium"];

function getTier(key) {
  return ARRIVONOW_TIERS[String(key || "").trim().toLowerCase()] || null;
}

function listTiers() {
  return ARRIVONOW_TIER_ORDER.map((key) => ARRIVONOW_TIERS[key]);
}

module.exports = {
  ARRIVONOW_TIERS,
  ARRIVONOW_TIER_ORDER,
  getTier,
  listTiers,
};
