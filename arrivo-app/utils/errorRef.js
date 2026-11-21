// Error refs and codes the rider can read out to support.
//
// Every API call gets a ref like RA-7KQ2MX. The server logs failures under the
// same ref (arrivo-backend/middleware/errorTrail.js), so support can look up
// exactly what happened from GET /api/error-log?ref=...
//
// Import-free on purpose so utils/errorRef.test.js can load it with node.

// Same alphabet as the server. No 0/O, 1/I/L, so it's easy to read out.
export const REF_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function newRef(random = Math.random) {
  let out = "RA-";
  for (let i = 0; i < 6; i++) out += REF_CHARS[Math.floor(random() * REF_CHARS.length) % REF_CHARS.length];
  return out;
}

// "Error code: RIDES_400 · Ref: RA-7KQ2MX", or "" when the error has neither.
export function errorCodeLine(err) {
  if (!err) return "";
  const parts = [];
  if (err.errorCode) parts.push(`Error code: ${err.errorCode}`);
  if (err.ref) parts.push(`Ref: ${err.ref}`);
  return parts.join(" · ");
}

// The message to show, with the code line under it so a screenshot has
// everything support needs.
export function messageWithCode(err, fallback) {
  const base = (err && err.message) || fallback || "Something went wrong. Please try again.";
  const line = errorCodeLine(err);
  return line ? `${base}\n\n${line}` : base;
}

// First few lines of a stack, short enough to send.
export function shortStack(err, lines = 6) {
  const s = err && err.stack ? String(err.stack) : "";
  return s.split("\n").slice(0, lines).join(" | ").slice(0, 1000);
}

// Keeps a small queue of reports so ones that couldn't be sent (no signal, or
// the app crashed) go out later. Newest kept, oldest dropped.
export function pushReport(queue, report, max = 20) {
  const next = [...(Array.isArray(queue) ? queue : []), report];
  return next.length > max ? next.slice(next.length - max) : next;
}
