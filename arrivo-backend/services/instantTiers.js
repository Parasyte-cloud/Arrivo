// ArrivoNow rider-facing vehicle tiers — the "pick your vehicle" step of
// on-demand booking. Each tier maps onto the SAME vehicles/vehicle_type
// data RideArrivo's scheduled bookings already use (see db/schema.sql and
// services/fare.js) — there is no separate ArrivoNow fleet.
//
// XL is the one tier that is not a distinct vehicle_type: it is an SUV
// with enough seats (vehicles.seats) to actually carry more people than a
// standard Comfort SUV, using a column that already existed on `vehicles`
// but was not previously filtered on for matching — see minSeats handling
// in services/instantDispatch.js findEligibleDrivers.
//
// Pricing knobs here are ArrivoNow-specific (see services/instantFare.js)
// and deliberately separate from services/fare.js's flat airport-transfer
// pricing table — ArrivoNow is metered point-to-point, not a fixed price
// per named neighbourhood, since neither trip endpoint is reliably the
// airport the way RideArrivo's core product assumes.
//
// PRICING NOTE: baseFareNaira / perKmNaira / perMinNaira / minimumFareNaira
// below are starting placeholders, not researched market rates — they need
// to be checked against real driver fuel/maintenance economics and
// competitor pricing (Bolt, inDrive) before ArrivoNow leaves the
// ARRIVO_NOW_ENABLED=false rollout gate.
const ARRIVONOW_TIERS = {
  economy: {
    key: "economy",
    label: "Economy",
    description: "Everyday sedan rides — the most affordable ArrivoNow tier.",
    vehicleType: "sedan",
    minSeats: 1,
    baseFareNaira: 500,
    perKmNaira: 150,
    perMinNaira: 20,
    minimumFareNaira: 1000,
  },
  comfort: {
    key: "comfort",
    label: "Comfort",
    description: "Newer SUVs with more legroom and boot space.",
    vehicleType: "suv",
    minSeats: 1,
    baseFareNaira: 700,
    perKmNaira: 200,
    perMinNaira: 25,
    minimumFareNaira: 1500,
  },
  xl: {
    key: "xl",
    label: "XL",
    description: "6+ seat SUVs for groups and extra luggage.",
    vehicleType: "suv",
    minSeats: 6,
    baseFareNaira: 900,
    perKmNaira: 250,
    perMinNaira: 30,
    minimumFareNaira: 2000,
  },
  premium: {
    key: "premium",
    label: "Premium",
    description: "RideArrivo's Executive fleet, chauffeur-grade comfort on demand.",
    vehicleType: "truck",
    minSeats: 1,
    baseFareNaira: 1500,
    perKmNaira: 350,
    perMinNaira: 40,
    minimumFareNaira: 3000,
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
