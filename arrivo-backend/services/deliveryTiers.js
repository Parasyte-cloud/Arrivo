// ArrivoExpress Delivery — two-wheeler parcel delivery, RideArrivo's answer
// to Uber Connect / Bolt Package / inDrive's courier options. Riders send a
// package instead of themselves: same on-demand dispatch pipeline as
// ArrivoExpress passenger rides (see services/instantTiers.js), but the
// vehicle tiers and pricing knobs are courier-specific, and the request
// carries a recipient (name + phone) instead of a second passenger.
//
// Two tiers, both two-wheelers on purpose — no car/SUV delivery tier yet.
// Bicycle courier is the cheapest, greenest option for small, non-urgent
// parcels; Motorcycle courier is faster and can carry a bigger/heavier
// package. This mirrors Uber's own bike-courier / motorbike-courier split
// rather than inventing a third tier RideArrivo has no rider demand
// signal for yet.
//
// PRICING NOTE: same caveat as services/instantTiers.js — these are
// starting placeholders, not researched market rates. They need checking
// against real courier economics (a bicycle courier's fuel-free but slower
// and can't take heavy loads; a motorcycle courier costs more per km in
// fuel but covers a delivery zone RideArrivo's zone map already prices for
// scooters/okadas) before ARRIVO_DELIVERY_ENABLED flips on in production.
const DELIVERY_VEHICLE_TIERS = {
  bicycle: {
    key: "bicycle",
    label: "Bicycle Delivery",
    description: "Documents and small parcels, delivered by bicycle courier — the cheapest, greenest option.",
    vehicleType: "bicycle",
    maxPackageKg: 5,
    baseFareNaira: 350,
    perKmNaira: 90,
    perMinNaira: 8,
    minimumFareNaira: 500,
  },
  motorcycle: {
    key: "motorcycle",
    label: "Motorcycle Delivery",
    description: "Faster delivery for bigger or heavier parcels, across longer distances.",
    vehicleType: "motorcycle",
    maxPackageKg: 20,
    baseFareNaira: 550,
    perKmNaira: 120,
    perMinNaira: 12,
    minimumFareNaira: 800,
  },
};

const DELIVERY_VEHICLE_TIER_ORDER = ["bicycle", "motorcycle"];

// Package size classes, independent of vehicle tier — mirrors the
// envelope/small/medium/large split Uber Connect and Bolt Package both
// use. `minVehicle` gates a size to couriers that can actually carry it
// (a bicycle's pannier/backpack tops out well before a motorcycle's).
const PACKAGE_SIZES = {
  envelope: {
    key: "envelope",
    label: "Envelope or documents",
    maxKg: 1,
    surchargeNaira: 0,
    minVehicle: null,
  },
  small: {
    key: "small",
    label: "Small parcel (fits a backpack)",
    maxKg: 5,
    surchargeNaira: 150,
    minVehicle: null,
  },
  medium: {
    key: "medium",
    label: "Medium parcel (small box)",
    maxKg: 12,
    surchargeNaira: 400,
    minVehicle: "motorcycle",
  },
  large: {
    key: "large",
    label: "Large parcel (needs a pannier or basket)",
    maxKg: 20,
    surchargeNaira: 750,
    minVehicle: "motorcycle",
  },
};

const PACKAGE_SIZE_ORDER = ["envelope", "small", "medium", "large"];

function getVehicleTier(key) {
  return DELIVERY_VEHICLE_TIERS[String(key || "").trim().toLowerCase()] || null;
}

function listVehicleTiers() {
  return DELIVERY_VEHICLE_TIER_ORDER.map((key) => DELIVERY_VEHICLE_TIERS[key]);
}

function getPackageSize(key) {
  return PACKAGE_SIZES[String(key || "").trim().toLowerCase()] || null;
}

function listPackageSizes() {
  return PACKAGE_SIZE_ORDER.map((key) => PACKAGE_SIZES[key]);
}

// A package size is eligible for a vehicle tier if the tier's maxPackageKg
// covers the size's maxKg AND the size doesn't name a stricter minVehicle
// (e.g. "medium"/"large" can't go by bicycle even though weight alone
// might allow it — panniers/baskets, not raw kg, are the real constraint).
function isPackageEligibleForVehicle(packageSizeKey, vehicleTierKey) {
  const size = getPackageSize(packageSizeKey);
  const vehicle = getVehicleTier(vehicleTierKey);

  if (!size || !vehicle) return false;
  if (size.maxKg > vehicle.maxPackageKg) return false;
  if (size.minVehicle && size.minVehicle !== vehicle.key) return false;

  return true;
}

// For a given package size, which vehicle tiers can actually carry it —
// used by the rider-facing picker so a "medium" or "large" parcel never
// even offers the Bicycle tier as an option.
function eligibleVehiclesForPackage(packageSizeKey) {
  return listVehicleTiers().filter((v) => isPackageEligibleForVehicle(packageSizeKey, v.key));
}

module.exports = {
  DELIVERY_VEHICLE_TIERS,
  DELIVERY_VEHICLE_TIER_ORDER,
  PACKAGE_SIZES,
  PACKAGE_SIZE_ORDER,
  getVehicleTier,
  listVehicleTiers,
  getPackageSize,
  listPackageSizes,
  isPackageEligibleForVehicle,
  eligibleVehiclesForPackage,
};
