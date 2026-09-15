const {
  findExcludedArea,
  classifyZone,
  isLagosNightTime,
} = require("./fare");

const {
  getVehicleTier,
  getPackageSize,
  isPackageEligibleForVehicle,
} = require("./deliveryTiers");

// Reuse the exact same zone/night pricing policy as ArrivoExpress passenger
// rides (services/instantFare.js) — a rider should never see two different
// answers to "does the yellow-zone surcharge apply right now" depending on
// whether they're sending a package or riding themselves.
const { ZONE_MULTIPLIER, NIGHT_MULTIPLIER } = require("./instantFare");

class DeliveryFareError extends Error {
  constructor(message, status = 400, code = "DELIVERY_FARE_ERROR") {
    super(message);
    this.name = "DeliveryFareError";
    this.status = status;
    this.code = code;
  }
}

const ROUND_TO_NAIRA = 50;

function roundUpToNearest(amount, step) {
  return Math.ceil(amount / step) * step;
}

// vehicleTier: 'bicycle' | 'motorcycle' (services/deliveryTiers.js)
// packageSize: 'envelope' | 'small' | 'medium' | 'large' (same file)
//
// Same itemised-breakdown shape as computeInstantFare so the app/website
// can render both quote types with one shared "fare summary" component —
// base + distance + time + package surcharge + zone/night multipliers.
function computeDeliveryFare({
  vehicleTier,
  packageSize,
  pickupAddress,
  destinationAddress,
  distanceKm,
  durationMin,
}) {
  const tierConfig = getVehicleTier(vehicleTier);

  if (!tierConfig) {
    throw new DeliveryFareError(
      `Unknown ArrivoExpress Delivery vehicle '${vehicleTier}'`,
      400,
      "UNKNOWN_DELIVERY_VEHICLE"
    );
  }

  const sizeConfig = getPackageSize(packageSize);

  if (!sizeConfig) {
    throw new DeliveryFareError(
      `Unknown package size '${packageSize}'`,
      400,
      "UNKNOWN_PACKAGE_SIZE"
    );
  }

  if (!isPackageEligibleForVehicle(sizeConfig.key, tierConfig.key)) {
    throw new DeliveryFareError(
      `A ${sizeConfig.label.toLowerCase()} needs a bigger courier than ${tierConfig.label}.`,
      422,
      "PACKAGE_TOO_BIG_FOR_VEHICLE"
    );
  }

  const excluded = findExcludedArea(destinationAddress) || findExcludedArea(pickupAddress);

  if (excluded) {
    throw new DeliveryFareError(
      `ArrivoExpress Delivery doesn't currently operate in ${excluded.name}.`,
      422,
      "AREA_NOT_SERVICED"
    );
  }

  const pickupZone = classifyZone(pickupAddress);
  const destinationZone = classifyZone(destinationAddress);
  const zone = pickupZone === "yellow" || destinationZone === "yellow" ? "yellow" : "green";
  const zoneMultiplier = ZONE_MULTIPLIER[zone] || 1;

  const distance = Math.max(0, Number(distanceKm) || 0);
  const duration = Math.max(0, Number(durationMin) || 0);

  const baseNaira = tierConfig.baseFareNaira;
  const distanceNaira = tierConfig.perKmNaira * distance;
  const timeNaira = tierConfig.perMinNaira * duration;
  const packageSurchargeNaira = sizeConfig.surchargeNaira;

  const meteredSubtotal = (baseNaira + distanceNaira + timeNaira + packageSurchargeNaira) * zoneMultiplier;

  const nightApplied = isLagosNightTime();
  const nightMultiplier = nightApplied ? NIGHT_MULTIPLIER : 1;

  const beforeMinimum = meteredSubtotal * nightMultiplier;
  const fareNaira = roundUpToNearest(
    Math.max(beforeMinimum, tierConfig.minimumFareNaira),
    ROUND_TO_NAIRA
  );

  return {
    fareNaira: Math.round(fareNaira),
    vehicleTier: tierConfig.key,
    vehicleType: tierConfig.vehicleType,
    packageSize: sizeConfig.key,
    zone,
    breakdown: {
      baseNaira: Math.round(baseNaira),
      distanceNaira: Math.round(distanceNaira),
      timeNaira: Math.round(timeNaira),
      packageSurchargeNaira: Math.round(packageSurchargeNaira),
      zoneMultiplier,
      nightMultiplier,
      minimumFareNaira: tierConfig.minimumFareNaira,
      minimumApplied: beforeMinimum < tierConfig.minimumFareNaira,
    },
  };
}

module.exports = {
  DeliveryFareError,
  computeDeliveryFare,
};
