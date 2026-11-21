// Small pure helpers for the trip welfare check. Import-free on purpose so a
// plain node test can load it. The rules themselves live on the server
// (arrivo-backend/services/welfareCheck.js); the app only reports where the
// rider is and shows the question the server asks. PArAsYtE
export const WELFARE_PING_MS = 30000;
export const WELFARE_GOOD_ACCURACY_M = 100;

// Only a trip that is really under way is watched.
export const shouldWatch = (rideStatus) => rideStatus === "in_progress";

// Seconds left to answer, never below zero. `deadline` is a ms timestamp.
export function secondsLeft(deadline, now) {
  if (!deadline) return 0;
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}

// "1:45" style countdown.
export function clock(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// What to send for a position the phone gave us, or null if it is not usable.
export function pingBody(position) {
  const c = position && position.coords;
  if (!c || !Number.isFinite(c.latitude) || !Number.isFinite(c.longitude)) return null;
  return { lat: c.latitude, lng: c.longitude, accuracy: Number.isFinite(c.accuracy) ? c.accuracy : undefined };
}
