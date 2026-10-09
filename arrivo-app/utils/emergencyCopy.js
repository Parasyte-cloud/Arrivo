// Every word the rider sees about the Emergency Button, in one place, so one
// edit changes it everywhere in the app.
//
// DRAFT. The wording mirrors the website (ridearrivo.com: the panic* strings in
// i18n.js and sections 12 and 10 of the privacy policy and terms), and all of
// it is waiting for counsel's review. Change it here and on the website
// together, otherwise the app and the site tell riders different things.
//
// This file holds the button copy only. The legal text itself is NOT copied
// into the app: the app links to the website pages below, so the policy and the
// terms have exactly one source of truth.
//
// House rule: no em dashes in anything a user reads.
//
// Import-free so utils/emergencyCopy.test.js can load it with node.

export const EMERGENCY_BUTTON_LABEL = "🚨 Emergency Button: I don't feel safe";
export const EMERGENCY_ONLY_NOTE = "Use this button only in an emergency.";

export const EMERGENCY_CONFIRM_TITLE = "Use the Emergency Button?";
export const EMERGENCY_CONFIRM_BODY =
  "Use this button only in an emergency. It immediately alerts RideArrivo's operations team with your ride details and location, and they may then activate the in-vehicle listening device so they can hear what is happening. Continue?";
export const EMERGENCY_CONFIRM_YES = "Yes, send the alert";
export const EMERGENCY_CONFIRM_CANCEL = "Cancel";

export const EMERGENCY_ACTIVE_MESSAGE = "🚨 Support has been alerted about this ride.";
export const EMERGENCY_SENT_TITLE = "Support has been alerted";
export const EMERGENCY_SENT_BODY =
  "Support has been alerted. If you're in immediate danger, please also call local emergency services.";
export const EMERGENCY_FAILED_TITLE = "Couldn't send the alert";
export const EMERGENCY_FAILED_BODY = "Couldn't send the alert: please try again, or call support directly.";

// Links to the full text. The anchors are the section ids on the website.
export const EMERGENCY_PRIVACY_URL = "https://ridearrivo.com/privacy.html#emergency-button";
export const EMERGENCY_TERMS_URL = "https://ridearrivo.com/terms.html#emergency-button";
export const EMERGENCY_PRIVACY_LABEL = "How this works: Privacy Policy";
export const EMERGENCY_TERMS_LABEL = "Terms of Service";
