// Safety wording shown in the app, kept in ONE place so counsel's final text
// can go in with a single edit. Import-free on purpose (a node test loads it).
//
// STATUS: DRAFT. Written from counsel's letters of 9 Oct 2026. Counsel has to
// approve the final wording before audio recording is switched on
// (RIDE_AUDIO_RECORDING_ENABLED stays false until then). The full legal text is
// on the website, so this links to it instead of copying it.
//
// House copy rule: no em dashes in anything a user reads.
// Keep this file identical in arrivo-app/utils and arrivo-driver-app/utils.

export const SAFETY_PRIVACY_URL = "ridearrivo.com/privacy.html";
export const SAFETY_TERMS_URL = "ridearrivo.com/terms.html";

// Retention periods recommended by counsel. The server value for emergency audio
// is RIDE_AUDIO_RETENTION_DAYS; keep them in step.
export const SAFETY_RETENTION = {
  emergencyAudioDays: 30,
  supportCallDays: 30,
  dashcamNoEventDays: 14,
};

// Asked before a rider or driver starts recording by themselves.
export const RECORDING_CONSENT = {
  title: "Record audio for safety?",
  body:
    "Audio from this trip will be recorded and stored securely, to help us respond to a safety concern. " +
    "Only authorised RideArrivo safety staff can listen to it and every listen is logged. " +
    `It is deleted after ${SAFETY_RETENTION.emergencyAudioDays} days unless it is needed for a safety investigation, a complaint or a legal claim. ` +
    "It may be shared with the police or another authority where the law requires it. " +
    "Your agreement covers you only, not other people in the vehicle. " +
    `Details are in our privacy policy at ${SAFETY_PRIVACY_URL}. You can stop at any time.`,
  agree: "I agree, record",
  notNow: "Not now",
};

// Emergency Button: used for emergencies only. It alerts operations at once and
// starts recording without a further prompt. The notice is given beforehand, in
// the pre-trip pop-up, the policies and the driver and vehicle owner agreements.
export const EMERGENCY_BUTTON_NOTICE = {
  title: "Emergency Button",
  body:
    "Use this only in an emergency. Pressing it alerts the RideArrivo operations team straight away and starts recording audio from this trip. " +
    `Recordings are kept for ${SAFETY_RETENTION.emergencyAudioDays} days. If you are in danger, also call 112.`,
};

// Live Support: speak to a RideArrivo support representative. Say this at the
// start of every call that is recorded.
export const SUPPORT_CALL_NOTICE =
  "This call with RideArrivo Live Support is recorded, to keep you safe, to check service quality and to resolve complaints. " +
  `Recordings are kept for ${SAFETY_RETENTION.supportCallDays} days. More in our privacy policy at ${SAFETY_PRIVACY_URL}.`;

// Shown before each trip to riders and drivers.
export const PRE_TRIP_NOTICE = {
  title: "Your safety on this trip",
  bullets: [
    "Emergency Button: for emergencies only. It alerts our operations team straight away and starts recording audio.",
    "Live Support: talk to a RideArrivo support representative. These calls are recorded, and we tell you at the start of the call.",
    `Dash cam: some vehicles have one. It records video only, with no audio. Footage with no incident is kept for ${SAFETY_RETENTION.dashcamNoEventDays} days.`,
    "Your agreement here covers you only, not other people in the vehicle. Read the safety and privacy pamphlet in the vehicle, or our privacy policy online.",
  ],
  ok: "Got it",
};
