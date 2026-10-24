// ArrivoAir, ArrivoBoat and ArrivoRemovals: the three tiers that are confirmed
// by RideArrivo operations before a driver is involved.
//
// Why a request and not a live dispatch: aircraft, boats and removal crews are
// not priced by distance and minutes the way a car is, and the right crew or
// craft has to be chosen by a person. So the rider sends one short request,
// operations replies with a price and names the driver, and from then on it is
// a normal job for that driver (start, complete). Same idea as On the Go.
//
// The pure rules live here so they can be tested without a database. The app
// builds carry a copy of TIERS in their own tiers folder; the parity test in
// serviceRequests.test.js reads the app files and fails if the two drift.

const { isValidPhone, phoneErrorMessage } = require("./phone");

const MAX_DETAILS_LENGTH = 1000;
const MAX_ADDRESS_LENGTH = 300;
// A request for a time that already passed is a mistake in the form. A few
// minutes of grace covers the gap between typing the time and it arriving.
const PAST_GRACE_MS = 10 * 60 * 1000;
const MAX_ADVANCE_DAYS = 180;

const TIERS = {
  air: {
    key: "air",
    label: "ArrivoAir",
    options: ["helicopter", "private_jet"],
    optionRequired: true,
    maxPassengers: 20,
    usesCrewSize: false,
  },
  boat: {
    key: "boat",
    label: "ArrivoBoat",
    options: ["speedboat", "ferry_transfer", "yacht"],
    optionRequired: true,
    maxPassengers: 60,
    usesCrewSize: false,
  },
  removals: {
    key: "removals",
    label: "ArrivoRemovals",
    options: ["studio", "one_bed", "two_bed", "three_plus_bed", "office"],
    optionRequired: true,
    maxPassengers: 1,
    usesCrewSize: true,
    crewSizes: [2, 4, 6],
  },
};

const TIER_KEYS = Object.keys(TIERS);

const STATUSES = ["pending", "confirmed", "in_progress", "completed", "cancelled"];
const OPEN_STATUSES = ["pending", "confirmed", "in_progress"];

// Who may move a request from one status to another.
//   rider   can withdraw it until the trip has started
//   driver  can only run the job they were assigned: start it, finish it
//   staff   confirm (with a price and a driver), and can cancel anything not finished
// "confirm" is its own step because it carries a fare and a driver, so it is
// not offered through the plain status transition used by drivers.
const TRANSITIONS = {
  rider: { pending: ["cancelled"], confirmed: ["cancelled"] },
  driver: { confirmed: ["in_progress"], in_progress: ["completed"] },
  staff: { pending: ["cancelled"], confirmed: ["cancelled"], in_progress: ["cancelled"] },
};

function canTransition(actor, from, to) {
  const allowed = TRANSITIONS[actor] && TRANSITIONS[actor][from];
  return !!allowed && allowed.includes(to);
}

function cleanText(value, max) {
  const text = String(value == null ? "" : value).trim();
  return text.length > max ? null : text;
}

// Returns { value } on success or { error } for a 400 response.
function parseCreate(body, now = Date.now()) {
  const b = body || {};
  const tier = TIERS[b.tier];
  if (!tier) return { error: `tier must be one of: ${TIER_KEYS.join(", ")}` };

  const pickup = cleanText(b.pickupAddress, MAX_ADDRESS_LENGTH);
  if (!pickup) return { error: b.pickupAddress ? `pickupAddress must be ${MAX_ADDRESS_LENGTH} characters or fewer` : "pickupAddress is required" };
  const destination = cleanText(b.destinationAddress, MAX_ADDRESS_LENGTH);
  if (!destination) return { error: b.destinationAddress ? `destinationAddress must be ${MAX_ADDRESS_LENGTH} characters or fewer` : "destinationAddress is required" };

  if (typeof b.requestedAt !== "string" || !b.requestedAt) return { error: "requestedAt is required" };
  const ms = new Date(b.requestedAt).getTime();
  if (!Number.isFinite(ms)) return { error: "requestedAt must be a valid date and time" };
  if (ms < now - PAST_GRACE_MS) return { error: "requestedAt is in the past" };
  if (ms > now + MAX_ADVANCE_DAYS * 24 * 60 * 60 * 1000) {
    return { error: `requestedAt is more than ${MAX_ADVANCE_DAYS} days away` };
  }

  let passengers = 1;
  if (tier.maxPassengers > 1) {
    passengers = Number(b.passengerCount);
    if (!Number.isInteger(passengers) || passengers < 1 || passengers > tier.maxPassengers) {
      return { error: `passengerCount must be a whole number from 1 to ${tier.maxPassengers}` };
    }
  }

  const option = b.option == null || b.option === "" ? null : String(b.option);
  if (tier.optionRequired && !option) return { error: "option is required" };
  if (option && !tier.options.includes(option)) {
    return { error: `option must be one of: ${tier.options.join(", ")}` };
  }

  let crewSize = null;
  if (tier.usesCrewSize) {
    crewSize = Number(b.crewSize);
    if (!tier.crewSizes.includes(crewSize)) {
      return { error: `crewSize must be one of: ${tier.crewSizes.join(", ")}` };
    }
  }

  if (!b.contactPhone || !String(b.contactPhone).trim()) return { error: "contactPhone is required" };
  if (!isValidPhone(b.contactPhone)) return { error: phoneErrorMessage("Contact phone number") };

  let details = null;
  if (b.details != null && b.details !== "") {
    const text = String(b.details).trim();
    if (text.length > MAX_DETAILS_LENGTH) return { error: `details must be ${MAX_DETAILS_LENGTH} characters or fewer` };
    details = text || null;
  }

  let idempotencyKey = null;
  if (b.idempotencyKey != null && b.idempotencyKey !== "") {
    idempotencyKey = String(b.idempotencyKey).trim();
    if (idempotencyKey.length > 80) return { error: "idempotencyKey must be 80 characters or fewer" };
  }

  return {
    value: {
      tier: tier.key,
      pickupAddress: pickup,
      destinationAddress: destination,
      requestedAt: new Date(ms).toISOString(),
      passengerCount: passengers,
      option,
      crewSize,
      contactPhone: String(b.contactPhone).trim(),
      details,
      idempotencyKey,
    },
  };
}

// Operations confirming a request: a price and the driver who will do it.
function parseConfirm(body) {
  const b = body || {};
  const fare = Number(b.fareNaira);
  if (!Number.isInteger(fare) || fare < 1000 || fare > 100000000) {
    return { error: "fareNaira must be a whole number of naira, at least 1000" };
  }
  const driverId = Number(b.driverId);
  if (!Number.isInteger(driverId) || driverId < 1 || driverId > 2147483647) {
    return { error: "driverId is required" };
  }
  return { value: { fareNaira: fare, driverId } };
}

// What each side is shown. Rider and driver never get the other's phone number
// (see services/contactPrivacy.js), and a driver only gets the rider's first
// name until the job is theirs.
function toRiderView(row) {
  return {
    id: row.id,
    tier: row.tier,
    status: row.status,
    pickupAddress: row.pickup_address,
    destinationAddress: row.destination_address,
    requestedAt: row.requested_at,
    passengerCount: row.passenger_count,
    option: row.option,
    crewSize: row.crew_size,
    details: row.details,
    quotedFareNaira: row.quoted_fare_naira,
    createdAt: row.created_at,
  };
}

function toDriverView(row) {
  return {
    id: row.id,
    tier: row.tier,
    status: row.status,
    pickupAddress: row.pickup_address,
    destinationAddress: row.destination_address,
    requestedAt: row.requested_at,
    passengerCount: row.passenger_count,
    option: row.option,
    crewSize: row.crew_size,
    details: row.details,
    fareNaira: row.quoted_fare_naira,
    riderFirstName: String(row.rider_name || "Rider").trim().split(/\s+/)[0],
  };
}

module.exports = {
  TIERS,
  TIER_KEYS,
  STATUSES,
  OPEN_STATUSES,
  MAX_DETAILS_LENGTH,
  MAX_ADDRESS_LENGTH,
  MAX_ADVANCE_DAYS,
  PAST_GRACE_MS,
  canTransition,
  parseCreate,
  parseConfirm,
  toRiderView,
  toDriverView,
};
