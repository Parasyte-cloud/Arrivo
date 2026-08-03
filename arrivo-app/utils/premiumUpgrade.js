// One place for the upgrade toggle's wording so Plan Route and Chauffeur
// Booking can't drift apart again. Both screens used to say "Luxury" with a
// description that changed shape depending on where you were ("Nicer Sedan for
// this trip", "Nicer SUV"), and "nicer" doesn't tell a rider what they're
// actually paying for.

// Mirrors LUXURY_SURCHARGE_USD in arrivo-backend/services/fare.js, which is
// what actually charges. This is display only, for before a quote comes back.
export const PREMIUM_UPGRADE_USD = { sedan: 60, suv: 100 };

export const PREMIUM_UPGRADE_LABEL = "Premium Trim Upgrade";

const VEHICLE_NAMES = { sedan: "Sedan", suv: "SUV" };

// ngnPerUsd comes off the fare quote, which both screens already have. Falls
// back to the dollar figure if no quote has landed yet, since showing nothing
// is worse than showing the number in the other currency for a second.
export function premiumUpgradePrice(vehicleType, ngnPerUsd, formatFare) {
  const usd = PREMIUM_UPGRADE_USD[vehicleType];
  if (!usd) return null;
  if (ngnPerUsd) return formatFare(usd * ngnPerUsd);
  return "$" + usd;
}

export function premiumUpgradeDescription(vehicleType, priceLabel) {
  const name = VEHICLE_NAMES[vehicleType] || "vehicle";
  return `Higher-spec ${name} for this trip, plus ${priceLabel}`;
}
