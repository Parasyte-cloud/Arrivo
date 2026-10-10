// Pure helpers for the Cash-out screen (no imports, loadable from a node test).

// "5,000", "₦5000", " 5000 " -> 5000. Anything that is not a whole positive
// number of naira -> null.
export function parseAmount(text) {
  const cleaned = String(text || "").replace(/[₦,\s]/g, "");
  if (!/^\d+$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return n > 0 && Number.isSafeInteger(n) ? n : null;
}

// Tone for a status tag.
export function statusTone(status) {
  return status === "paid" ? "teal" : "amber";
}

// Which message to show for an API error. hasMessage(key) says whether a
// translation exists. Falls back to the server's own text, then a generic one.
export function errorKey(error, hasMessage) {
  const code = error && error.code;
  if (code && hasMessage(`e_${code}`)) return `e_${code}`;
  return null;
}

// A new idempotency key per attempt: tapping Withdraw twice sends the same key,
// so the server returns the first cash-out instead of making a second.
export function newIdempotencyKey(now = Date.now(), rand = Math.random) {
  return `${now}-${rand().toString(36).slice(2, 10)}`;
}

export function filterBanks(banks, query) {
  const q = String(query || "").trim().toLowerCase();
  return q ? banks.filter((b) => b.name.toLowerCase().includes(q)) : banks;
}
