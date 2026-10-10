// Small pure helpers for the safety screens, so they can be tested without a phone.

export const DRIVER_COMPLAINT_CATEGORIES = ["harassment", "aggressive", "damage", "no_show", "unsafe_request", "intoxicated", "other"];

// Keep only digits, at most 4, as the driver types.
export function cleanPin(text) {
  return String(text || "").replace(/\D/g, "").slice(0, 4);
}

export function pinReady(text) {
  return cleanPin(text).length === 4;
}

export function descriptionOk(text) {
  return String(text || "").replace(/\s+/g, " ").trim().length >= 10;
}

// A message key for an API error, or null (then the screen shows e_generic or the server message).
export function safetyErrorKey(error, hasMessage) {
  const code = error && error.code;
  return code && hasMessage(`e_${code}`) ? `e_${code}` : null;
}

// Turn the selfie status the server returns into what the screen should say.
//   returns { key, params } for a message, or null when nothing needs saying.
export function selfieNotice(status) {
  if (!status || !status.required) return null;
  if (status.reason === "rejected") return { key: "selfieRejected", params: { note: (status.latest && status.latest.note) || "" } };
  if (!status.allowed) return { key: "selfieNeedNew" };
  return null;
}
