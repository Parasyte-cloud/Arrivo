// Prices for the two add-ons that never showed one. Premium Trim Upgrade has
// told riders what it costs since the rename (see premiumUpgrade.js), while
// Security escort and Fleet accompaniment sat there as a switch and a row of
// chips with no number anywhere, so the fare moved and nobody knew why.
//
// Mirrors SECURITY_ESCORT_PRICE_USD and FLEET_PRICE_NAIRA in
// arrivo-backend/services/fare.js, which is what actually charges. These are
// display only. addonPricing.test.js reads the backend file and fails if the
// two ever disagree, because a wrong price on screen is worse than none.

// Escort is priced in dollars and converted, the way the premium upgrade is.
export const SECURITY_ESCORT_USD = 100;

// Fleet is priced in naira directly, so there is nothing to convert.
export const FLEET_PRICE_NAIRA = { 2: 70000, 3: 100000 };

export const FLEET_SIZES = [0, 2, 3];

// ngnPerUsd comes off the fare quote. Before a quote lands there is nothing to
// convert with, so fall back to the dollar figure rather than showing nothing,
// same call premiumUpgradePrice makes.
export function securityEscortPrice(ngnPerUsd, formatFare) {
  if (ngnPerUsd) return formatFare(SECURITY_ESCORT_USD * ngnPerUsd);
  return "$" + SECURITY_ESCORT_USD;
}

export function securityEscortDescription(ngnPerUsd, formatFare) {
  return `A dedicated security vehicle for this trip, plus ${securityEscortPrice(ngnPerUsd, formatFare)}`;
}

// Already naira, so this needs no rate and works before a quote arrives.
export function fleetPrice(size, formatFare) {
  const naira = FLEET_PRICE_NAIRA[size];
  if (!naira) return null;
  return formatFare(naira);
}

// The chip label carries the price so a rider sees it without selecting first.
export function fleetChipLabel(size, formatFare) {
  if (!size) return "None";
  return `${size} vehicles · ${fleetPrice(size, formatFare)}`;
}

export function fleetDescription(size, formatFare) {
  if (!size) return "Extra vehicles travelling the same route with you.";
  return `${size} extra vehicles travelling the same route, plus ${fleetPrice(size, formatFare)}`;
}
