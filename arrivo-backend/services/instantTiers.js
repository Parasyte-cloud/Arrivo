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
// PRICING NOTE (updated 2026-09-22): benchmarked against the best dated
// competitor data point we could find — Bolt Lagos economy fares as of
// Sept 2023 (base ~₦527, ~₦130/km, ~₦23.3/min, ₦800 minimum),
// adjusted upward ~35-45% for the documented 2025 Bolt fare increase
// (~15%) plus ongoing Nigerian fuel-cost/inflation trends through 2026,
// then rounded to clean increments. This is a defensible estimate, NOT a
// live quote — competitor pricing changes often and our source data was
// dated. Before ArrivoExpress leaves the ARRIVO_NOW_ENABLED=false rollout
// gate, pull a real same-route quote from the Bolt/Uber/inDrive apps and
// true these numbers up, and validate the economy base+per-km+per-min
// combo actually clears fuel/maintenance cost for a driver on a typical
// Lagos trip. Tiers above economy scale off it with one consistent
// multiplier per tier (comfort x1.35, xl x1.7, premium x2.5) across all
// four fields, instead of the previous ad hoc per-field numbers, so
// relative tier pricing stays predictable as the economy anchor changes.
const ARRIVONOW_TIERS = {
  economy: {
    key: "economy",
    label: "Economy",
    description: "Everyday sedan rides: the most affordable ArrivoExpress tier.",
    vehicleType: "sedan",
    minSeats: 1,
    baseFareNaira: 600,
    perKmNaira: 180,
    perMinNaira: 25,
    minimumFareNaira: 1200,
  },
  comfort: {
    key: "comfort",
    label: "Comfort",
    description: "Newer SUVs with more legroom and boot space.",
    vehicleType: "suv",
    minSeats: 1,
    baseFareNaira: 800,
    perKmNaira: 240,
    perMinNaira: 35,
    minimumFareNaira: 1600,
  },
  xl: {
    key: "xl",
    label: "XL",
    description: "6+ seat SUVs for groups and extra luggage.",
    vehicleType: "suv",
    minSeats: 6,
    baseFareNaira: 1000,
    perKmNaira: 300,
    perMinNaira: 45,
    minimumFareNaira: 2000,
  },
  premium: {
    key: "premium",
    label: "Premium",
    description: "RideArrivo's Executive fleet, chauffeur-grade comfort on demand.",
    vehicleType: "truck",
    minSeats: 1,
    baseFareNaira: 1500,
    perKmNaira: 450,
    perMinNaira: 65,
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
