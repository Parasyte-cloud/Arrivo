// hour12 is set explicitly everywhere this is used — without it,
// toLocaleTimeString/toLocaleString fall back to whatever locale the
// browser/OS resolves to, which on the deployed build was silently
// rendering 24-hour time even though AM/PM display was intended.

export function formatDateTime(isoString) {
  const d = new Date(isoString);
  const date = d.toLocaleDateString();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: true });
  return `${date} · ${time}`;
}

export function formatTime(isoString) {
  return new Date(isoString).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: true });
}
