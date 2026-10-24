// ArrivoAir, ArrivoBoat and ArrivoRemovals: what the request form asks for,
// how it is checked on the phone, and how a request's status is shown.
//
// The same rules are enforced again by the server (arrivo-backend
// services/serviceRequests.js). The backend test suite reads this file and
// fails if the options or limits here ever drift from the server's.
//
// Kept import-free on purpose so tiers/requestTiers.test.js can load it with node.

export const REQUEST_TIER_IDS = ["air", "boat", "removals"];

export const MAX_DETAILS_LENGTH = 1000;
export const MAX_ADDRESS_LENGTH = 300;
export const MAX_ADVANCE_DAYS = 180;
// Same grace the server allows, so a time picked a moment ago is not refused.
export const PAST_GRACE_MS = 10 * 60 * 1000;

export const REQUEST_TIERS = {
  air: {
    id: "air",
    label: "ArrivoAir",
    cta: "Request a flight",
    pickupLabel: "From",
    pickupHint: "Heliport, airstrip or airport",
    destinationLabel: "To",
    destinationHint: "Where you are flying to",
    whenLabel: "Departure",
    optionLabel: "Aircraft",
    options: [
      { value: "helicopter", label: "Helicopter" },
      { value: "private_jet", label: "Private jet" },
    ],
    maxPassengers: 20,
    passengerLabel: "Passengers",
    usesCrewSize: false,
    crewSizes: [],
    detailsHint: "Luggage, special requests",
    steps: ["Tell us the route and time", "We call you with the price and aircraft", "Your pilot and crew meet you on the day"],
  },
  boat: {
    id: "boat",
    label: "ArrivoBoat",
    cta: "Request a boat",
    pickupLabel: "From",
    pickupHint: "Jetty or waterfront",
    destinationLabel: "To",
    destinationHint: "Where you are going",
    whenLabel: "Departure",
    optionLabel: "Boat type",
    options: [
      { value: "speedboat", label: "Speedboat" },
      { value: "ferry_transfer", label: "Ferry transfer" },
      { value: "yacht", label: "Yacht" },
    ],
    maxPassengers: 60,
    passengerLabel: "Passengers",
    usesCrewSize: false,
    crewSizes: [],
    detailsHint: "Luggage, occasion, special requests",
    steps: ["Tell us the route and time", "We call you with the price and boat", "Your captain meets you at the jetty"],
  },
  removals: {
    id: "removals",
    label: "ArrivoRemovals",
    cta: "Request a move",
    pickupLabel: "Moving from",
    pickupHint: "Full address",
    destinationLabel: "Moving to",
    destinationHint: "Full address",
    whenLabel: "Moving day",
    optionLabel: "Size of move",
    options: [
      { value: "studio", label: "Studio" },
      { value: "one_bed", label: "1 bedroom" },
      { value: "two_bed", label: "2 bedroom" },
      { value: "three_plus_bed", label: "3+ bedroom" },
      { value: "office", label: "Office" },
    ],
    maxPassengers: 1,
    passengerLabel: "",
    usesCrewSize: true,
    crewSizes: [2, 4, 6],
    crewLabel: "Crew",
    detailsHint: "Heavy items, stairs, parking, anything we should know",
    steps: ["Tell us what you are moving and when", "We call you with the price", "Your crew and truck arrive on moving day"],
  },
};

const PHONE = /^\+[1-9]\d{7,14}$/;

function text(v) {
  return String(v == null ? "" : v).trim();
}

// values: { pickupAddress, destinationAddress, when (Date or ISO string or null),
//           passengerCount, option, crewSize, contactPhone, details }
// Returns { ok, errors, payload }. errors is keyed by field so the form can
// put each message under the field it belongs to. payload is what the server
// takes, and is only present when ok.
export function validateRequest(tierId, values, now = Date.now()) {
  const tier = REQUEST_TIERS[tierId];
  if (!tier) return { ok: false, errors: { tier: "Choose a service." }, payload: null };
  const v = values || {};
  const errors = {};

  const pickup = text(v.pickupAddress);
  if (!pickup) errors.pickupAddress = `Enter where ${tierId === "removals" ? "you are moving from" : "you are starting from"}.`;
  else if (pickup.length > MAX_ADDRESS_LENGTH) errors.pickupAddress = `Keep this under ${MAX_ADDRESS_LENGTH} characters.`;

  const destination = text(v.destinationAddress);
  if (!destination) errors.destinationAddress = `Enter where ${tierId === "removals" ? "you are moving to" : "you are going"}.`;
  else if (destination.length > MAX_ADDRESS_LENGTH) errors.destinationAddress = `Keep this under ${MAX_ADDRESS_LENGTH} characters.`;

  let whenIso = null;
  const whenMs = v.when instanceof Date ? v.when.getTime() : v.when ? new Date(v.when).getTime() : NaN;
  if (!Number.isFinite(whenMs)) errors.when = "Choose a date and time.";
  else if (whenMs < now - PAST_GRACE_MS) errors.when = "That time has already passed.";
  else if (whenMs > now + MAX_ADVANCE_DAYS * 24 * 60 * 60 * 1000) errors.when = `Choose a date within the next ${MAX_ADVANCE_DAYS} days.`;
  else whenIso = new Date(whenMs).toISOString();

  let passengers = 1;
  if (tier.maxPassengers > 1) {
    const raw = text(v.passengerCount);
    passengers = Number(raw);
    if (!raw || !Number.isInteger(passengers) || passengers < 1 || passengers > tier.maxPassengers) {
      errors.passengerCount = `Enter a number from 1 to ${tier.maxPassengers}.`;
    }
  }

  const option = text(v.option);
  if (!option) errors.option = `Choose ${tier.optionLabel.toLowerCase()}.`;
  else if (!tier.options.some((o) => o.value === option)) errors.option = `Choose ${tier.optionLabel.toLowerCase()}.`;

  let crewSize = null;
  if (tier.usesCrewSize) {
    crewSize = Number(v.crewSize);
    if (!tier.crewSizes.includes(crewSize)) errors.crewSize = "Choose a crew size.";
  }

  const phone = text(v.contactPhone);
  if (!phone) errors.contactPhone = "Enter a number we can call.";
  else if (!PHONE.test(phone)) errors.contactPhone = "Include the country code, for example +2348012345678.";

  const details = text(v.details);
  if (details.length > MAX_DETAILS_LENGTH) errors.details = `Keep this under ${MAX_DETAILS_LENGTH} characters.`;

  if (Object.keys(errors).length) return { ok: false, errors, payload: null };

  return {
    ok: true,
    errors: {},
    payload: {
      tier: tierId,
      pickupAddress: pickup,
      destinationAddress: destination,
      requestedAt: whenIso,
      passengerCount: passengers,
      option,
      crewSize,
      contactPhone: phone,
      details: details || undefined,
    },
  };
}

// How a request's status reads to the rider. step is 1 to 4 for the progress
// line; cancelled has no step.
export const REQUEST_STATUS = {
  pending: { label: "Waiting for our team", detail: "We will call you shortly to confirm the details and price.", step: 1 },
  confirmed: { label: "Confirmed", detail: "Your price and driver are set. They will meet you on the day.", step: 2 },
  in_progress: { label: "Under way", detail: "Your trip has started.", step: 3 },
  completed: { label: "Completed", detail: "Thank you for travelling with us.", step: 4 },
  cancelled: { label: "Cancelled", detail: "This request was cancelled.", step: 0 },
};

export function statusInfo(status) {
  return REQUEST_STATUS[status] || { label: "Unknown", detail: "", step: 0 };
}

// A rider can withdraw a request until the trip starts. The server checks too.
export function canCancel(status) {
  return status === "pending" || status === "confirmed";
}

// A request still moving, so the status screen keeps refreshing it.
export function isOpen(status) {
  return status === "pending" || status === "confirmed" || status === "in_progress";
}

export function formatNaira(amount) {
  // No price yet must read as blank, never as a free trip.
  if (amount == null || amount === "") return "";
  const n = Number(amount);
  if (!Number.isFinite(n)) return "";
  const whole = String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `₦${whole}`;
}

export function optionLabel(tierId, value) {
  const tier = REQUEST_TIERS[tierId];
  const found = tier && tier.options.find((o) => o.value === value);
  return found ? found.label : value || "";
}
