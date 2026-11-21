// "This build is too old" state, shared by the request layer (which sees the
// 426 answer) and the screen that tells the rider to update.
//
// The backend answers 426 with code "app_update_required" when the app's
// version is below the configured minimum (arrivo-backend/services/appVersion.js).
// Any request can be the one that finds out, so the request layer records it
// here and the root of the app swaps to the update screen.
//
// Import-free so utils/updateRequired.test.js can load it with node.

let current = null;
const listeners = new Set();

// Only an https link is ever opened from a server answer.
function safeStoreUrl(url) {
  return typeof url === "string" && /^https:\/\/[^\s]+$/.test(url.trim()) ? url.trim() : null;
}

// Returns { message, minVersion, storeUrl } for a genuine update-required
// answer, otherwise null. Any other 426, or a body without the code, is not
// treated as one, so a proxy or an unrelated 426 cannot lock the app.
export function parseUpdateRequired(status, data) {
  if (status !== 426 || !data || data.code !== "app_update_required") return null;
  return {
    message: typeof data.error === "string" && data.error ? data.error.slice(0, 200) : "Please update the RideArrivo app to keep going.",
    minVersion: typeof data.minVersion === "string" ? data.minVersion.slice(0, 32) : null,
    storeUrl: safeStoreUrl(data.storeUrl),
  };
}

export function getUpdateRequired() {
  return current;
}

export function subscribeUpdateRequired(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Called by the request layer with every response's status and body. Cheap and
// safe to call on every response.
export function noteResponse(status, data) {
  const info = parseUpdateRequired(status, data);
  if (!info) return;
  current = info;
  listeners.forEach((listener) => listener());
}
