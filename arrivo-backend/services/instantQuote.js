const {
  getDistanceDuration,
} = require("./googleMaps");

const {
  computeInstantFare,
  InstantFareError,
} = require("./instantFare");

const {
  getTier,
  listTiers,
} = require("./instantTiers");

class InstantQuoteError extends Error {
  constructor(message, status = 400, code = "INVALID_INSTANT_QUOTE") {
    super(message);
    this.name = "InstantQuoteError";
    this.status = status;
    this.code = code;
  }
}

function requiredText(value, name) {
  const cleaned = String(value || "").trim();

  if (!cleaned) {
    throw new InstantQuoteError(
      `${name} is required`
    );
  }

  if (cleaned.length > 500) {
    throw new InstantQuoteError(
      `${name} is too long`
    );
  }

  return cleaned;
}

function coordinate(value, name, min, max) {
  const parsed = Number(value);

  if (
    !Number.isFinite(parsed)
    || parsed < min
    || parsed > max
  ) {
    throw new InstantQuoteError(
      `${name} must be a valid coordinate`
    );
  }

  return parsed;
}

function validateInstantTripInput(input = {}) {
  const tierKey = String(
    input.tier || ""
  ).trim().toLowerCase();

  const tierConfig = getTier(tierKey);

  if (!tierConfig) {
    throw new InstantQuoteError(
      `tier must be one of: ${listTiers().map((t) => t.key).join(", ")}`
    );
  }

  return {
    pickupAddress: requiredText(
      input.pickupAddress,
      "pickupAddress"
    ),
    pickupLat: coordinate(
      input.pickupLat,
      "pickupLat",
      -90,
      90
    ),
    pickupLng: coordinate(
      input.pickupLng,
      "pickupLng",
      -180,
      180
    ),
    destinationAddress: requiredText(
      input.destinationAddress,
      "destinationAddress"
    ),
    destinationLat: coordinate(
      input.destinationLat,
      "destinationLat",
      -90,
      90
    ),
    destinationLng: coordinate(
      input.destinationLng,
      "destinationLng",
      -180,
      180
    ),
    tier: tierConfig.key,
    vehicleType: tierConfig.vehicleType,
    minSeats: tierConfig.minSeats,
  };
}

async function quoteInstantRide(input) {
  const trip = validateInstantTripInput(input);

  let route;

  try {
    route = await getDistanceDuration(
      trip.pickupLat,
      trip.pickupLng,
      trip.destinationLat,
      trip.destinationLng
    );
  } catch (error) {
    const wrapped = new InstantQuoteError(
      "We couldn't calculate this route right now. Please try again.",
      502,
      "ROUTING_UNAVAILABLE"
    );

    wrapped.cause = error;
    throw wrapped;
  }

  const distanceKm = Number(route?.distanceKm);
  const durationMin = Number(route?.durationMin);

  if (
    !Number.isFinite(distanceKm)
    || distanceKm < 0
    || !Number.isFinite(durationMin)
    || durationMin < 0
  ) {
    throw new InstantQuoteError(
      "The calculated route is invalid.",
      502,
      "INVALID_ROUTE_RESULT"
    );
  }

  let fare;

  try {
    // ArrivoExpress has its own metered, point-to-point fare model — see
    // services/instantFare.js. Unlike RideArrivo's scheduled one-way
    // trips, an ArrivoExpress ride is not reliably to/from the airport, so the
    // flat per-neighbourhood pricing in services/fare.js does not apply
    // here.
    fare = computeInstantFare({
      tier: trip.tier,
      pickupAddress: trip.pickupAddress,
      destinationAddress: trip.destinationAddress,
      distanceKm,
      durationMin,
    });
  } catch (error) {
    if (error instanceof InstantFareError) {
      throw new InstantQuoteError(error.message, error.status, error.code);
    }

    throw error;
  }

  if (
    !Number.isInteger(fare.fareNaira)
    || fare.fareNaira <= 0
  ) {
    throw new InstantQuoteError(
      "The calculated fare is invalid.",
      500,
      "INVALID_SERVER_FARE"
    );
  }

  return {
    ...trip,
    fareNaira: fare.fareNaira,
    breakdown: fare.breakdown,
    zone: fare.zone,
    distanceKm,
    durationMin,
    currency: "NGN",
    pricingModel: "arrivonow_metered_v1",
  };
}

module.exports = {
  InstantQuoteError,
  validateInstantTripInput,
  quoteInstantRide,
};
