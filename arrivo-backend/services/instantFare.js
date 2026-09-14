const {
  findExcludedArea,
  classifyZone,
  isLagosNightTime,
} = require("./fare");

const { getTier } = require("./instantTiers");

class InstantFareError extends Error {
  constructor(message, status = 400, code = "INSTANT_FARE_ERROR") {
    super(message);
    this.name = "InstantFareError";
    this.status = status;
    this.code = code;
  }
}

// Same all-in night uplift RideArrivo's scheduled one-way pricing already
// applies (services/fare.js NIGHT_MULTIPLIER) — kept identical so a rider
// does not see two different night policies depending on which product
// they booked.
const NIGHT_MULTIPLIER = 1.2;

// A busier/traffic-heavy corridor costs a bit more per km — this is NOT a
// surge multiplier (surge reacts to live demand/supply and is explicitly
// out of scope for ArrivoNow V1; see the engineering brief). It is a
// fixed, publishable rate difference tied to the zone itself, so riders in
// the same area always see the same multiplier regardless of time or
// demand — predictable, the way RideArrivo's Chauffeur product already
// treats zone pricing.
const ZONE_MULTIPLIER = { green: 1, yellow: 1.15 };

const ROUND_TO_NAIRA = 50;

function roundUpToNearest(amount, step) {
  return Math.ceil(amount / step) * step;
}

// tier: 'economy' | 'comfort' | 'xl' | 'premium' (see services/instantTiers.js)
//
// Returns the metered fare plus an itemised breakdown so the app can show
// riders exactly what they are paying for (base + distance + time + zone)
// — the same "itemised digital receipt" pattern called out in the Uber
// teardown brief.
function computeInstantFare({
  tier,
  pickupAddress,
  destinationAddress,
  distanceKm,
  durationMin,
}) {
  const tierConfig = getTier(tier);

  if (!tierConfig) {
    throw new InstantFareError(`Unknown ArrivoNow tier '${tier}'`, 400, "UNKNOWN_TIER");
  }

  const excluded = findExcludedArea(destinationAddress) || findExcludedArea(pickupAddress);

  if (excluded) {
    throw new InstantFareError(
      `ArrivoNow doesn't currently operate in ${excluded.name}.`,
      422,
      "AREA_NOT_SERVICED"
    );
  }

  // Whichever endpoint sits in the busier zone sets the multiplier — a
  // trip touching a Yellow-zone corridor at either end still deals with
  // that corridor's traffic, regardless of which side is pickup vs
  // drop-off.
  const pickupZone = classifyZone(pickupAddress);
  const destinationZone = classifyZone(destinationAddress);
  const zone = pickupZone === "yellow" || destinationZone === "yellow" ? "yellow" : "green";
  const zoneMultiplier = ZONE_MULTIPLIER[zone] || 1;

  const distance = Math.max(0, Number(distanceKm) || 0);
  const duration = Math.max(0, Number(durationMin) || 0);

  const baseNaira = tierConfig.baseFareNaira;
  const distanceNaira = tierConfig.perKmNaira * distance;
  const timeNaira = tierConfig.perMinNaira * duration;

  const meteredSubtotal = (baseNaira + distanceNaira + timeNaira) * zoneMultiplier;

  const nightApplied = isLagosNightTime();
  const nightMultiplier = nightApplied ? NIGHT_MULTIPLIER : 1;

  const beforeMinimum = meteredSubtotal * nightMultiplier;
  const fareNaira = roundUpToNearest(
    Math.max(beforeMinimum, tierConfig.minimumFareNaira),
    ROUND_TO_NAIRA
  );

  return {
    fareNaira: Math.round(fareNaira),
    tier: tierConfig.key,
    vehicleType: tierConfig.vehicleType,
    minSeats: tierConfig.minSeats,
    zone,
    breakdown: {
      baseNaira: Math.round(baseNaira),
      distanceNaira: Math.round(distanceNaira),
      timeNaira: Math.round(timeNaira),
      zoneMultiplier,
      nightMultiplier,
      minimumFareNaira: tierConfig.minimumFareNaira,
      minimumApplied: beforeMinimum < tierConfig.minimumFareNaira,
    },
  };
}

module.exports = {
  InstantFareError,
  computeInstantFare,
  ZONE_MULTIPLIER,
  NIGHT_MULTIPLIER,
};
