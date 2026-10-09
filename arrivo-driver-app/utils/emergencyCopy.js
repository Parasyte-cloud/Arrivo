// Every word the driver sees about the Emergency Button, in one place, so one
// edit changes it everywhere in the app.
//
// DRAFT. The wording mirrors the website (ridearrivo.com: the panic* strings in
// i18n.js and sections 12 and 10 of the privacy policy and terms), and all of
// it is waiting for counsel's review. Change it here, in the rider app's own
// copy of this file and on the website together, otherwise they tell people
// different things.
//
// This file holds the button copy only. The legal text itself is NOT copied
// into the app: the app links to the website pages below, so the policy and the
// terms have exactly one source of truth.
//
// House rule: no em dashes in anything a user reads.
//
// Import-free so utils/emergencyCopy.test.js can load it with node.

export const EMERGENCY_BUTTON_LABEL = "🚨 Emergency Button";
export const EMERGENCY_ONLY_NOTE = "Use this button only in an emergency.";

// Shown while the three second countdown runs, so the driver is told what the
// button does before it sends, and can still cancel.
export const EMERGENCY_COUNTDOWN_NOTICE =
  "It immediately alerts RideArrivo's operations team with your trip details and location, and they may then activate the in-vehicle listening device so they can hear what is happening.";
export function emergencyCountdownText(seconds) {
  return `Sending emergency alert in ${seconds}...`;
}
export const EMERGENCY_CANCEL_LABEL = "Cancel";

export const EMERGENCY_ACTIVE_TITLE = "Emergency alert active";
export const EMERGENCY_ACTIVE_SENDING = "Sending to RideArrivo's team...";
export const EMERGENCY_ACTIVE_SENT =
  "Our team has been notified and is monitoring this trip. This can only be cleared once resolved on our end.";
export const EMERGENCY_ACTIVE_FAILED =
  "Couldn't confirm this reached RideArrivo's servers. Please also call support directly if you're in danger.";
export const EMERGENCY_RETRY_LABEL = "Retry sending alert";

// Links to the full text. The anchors are the section ids on the website.
export const EMERGENCY_PRIVACY_URL = "https://ridearrivo.com/privacy.html#emergency-button";
export const EMERGENCY_TERMS_URL = "https://ridearrivo.com/terms.html#emergency-button";
export const EMERGENCY_PRIVACY_LABEL = "How this works: Privacy Policy";
export const EMERGENCY_TERMS_LABEL = "Terms of Service";
