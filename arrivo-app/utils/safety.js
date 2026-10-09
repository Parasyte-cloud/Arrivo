// Small pure helpers for the safety cards, testable without a phone.

export const RIDER_COMPLAINT_CATEGORIES = ["unsafe_driving", "harassment", "felt_unsafe", "wrong_route", "overcharge", "vehicle_mismatch", "rude", "other"];

export function descriptionOk(text) {
  return String(text || "").replace(/\s+/g, " ").trim().length >= 10;
}

// Show the PIN card only while the server hands out a PIN (driver assigned, trip not started).
export function shouldShowPin(info) {
  return Boolean(info && info.required && info.pin);
}

// "4 8 2 1" reads better aloud than "4821".
export function spacedPin(pin) {
  return String(pin || "").split("").join(" ");
}
