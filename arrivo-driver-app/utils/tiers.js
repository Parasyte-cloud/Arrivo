// Which services (tiers) a driver works, and what each one shows on the
// Dashboard. Pure and import-free so a node test can load it (see
// utils/tiers.test.js). The server decides who holds what
// (arrivo-backend/services/driverTiers.js); this only shapes the screen.
//
// Work from one tier never shows inside another:
//   ride       airport pickups and drop-offs (booking_type one_way, dropoff)
//   express    on-demand offers, with their own opt-in switch
//   chauffeur  charters (booking_type full_day, full_week, full_month)
//   campus, air, boat, removals  no jobs in the app yet, so a clear pane

export const TIER_ORDER = ["ride", "express", "chauffeur", "campus", "air", "boat", "removals"];

export const TIER_FALLBACK = {
  ride: { name: "RideArrivo", tagline: "Airport pickups and drop-offs", accent: "#F4A300", live: true },
  express: { name: "ArrivoExpress", tagline: "On-demand city rides", accent: "#F5B942", live: true },
  chauffeur: { name: "ArrivoChauffeur", tagline: "Hire a driver by the day", accent: "#E8D9A8", live: true },
  campus: { name: "ArrivoCampus", tagline: "Student rides", accent: "#5AA9FF", live: false },
  air: { name: "ArrivoAir", tagline: "Airport transfers on a plan", accent: "#B69CFF", live: false },
  boat: { name: "ArrivoBoat", tagline: "Water transport", accent: "#3ED6C4", live: false },
  removals: { name: "ArrivoRemovals", tagline: "Moves and haulage", accent: "#FF8A5B", live: false },
};

const CHARTER = ["full_day", "full_week", "full_month"];

// Same rule as the server: charters are Chauffeur, every other booking on the
// rides queue is RideArrivo.
export function tierForRide(ride) {
  return CHARTER.includes(String((ride && ride.booking_type) || "").toLowerCase()) ? "chauffeur" : "ride";
}

// The tier to show: the one the driver last chose if they still hold it,
// otherwise the first one they hold, in the fixed order. null when they hold none.
export function pickTier(active, saved) {
  const held = TIER_ORDER.filter((t) => (active || []).includes(t));
  if (!held.length) return null;
  return saved && held.includes(saved) ? saved : held[0];
}

// What the Dashboard draws for the chosen tier.
//   legacy: the server has no tiers yet (older backend), draw everything as before.
export function sectionsFor(current, { legacy = false } = {}) {
  if (legacy) return { express: true, queue: true, pane: false, queueTier: null };
  if (!current) return { express: false, queue: false, pane: true, queueTier: null };
  if (current === "express") return { express: true, queue: false, pane: false, queueTier: null };
  if (current === "ride" || current === "chauffeur") return { express: false, queue: true, pane: false, queueTier: current };
  return { express: false, queue: false, pane: true, queueTier: null };
}

// Only the requests that belong to this tier's queue.
export function queueFor(rides, queueTier) {
  if (!queueTier) return rides || [];
  return (rides || []).filter((r) => tierForRide(r) === queueTier);
}

// Name, tagline and accent for a tier, from the server's answer if it has one.
export function metaFor(slug, tiers) {
  const fromServer = (tiers || []).find((t) => t.slug === slug);
  return { ...(TIER_FALLBACK[slug] || { name: slug, tagline: "", accent: "#F4A300", live: false }), ...(fromServer || {}), slug };
}

// The button on a tier row in "Your services".
//   on          nothing to do
//   requested   waiting for Ops
//   off, revoked  can ask
export function rowAction(status) {
  if (status === "active") return { kind: "none", label: "On" };
  if (status === "requested") return { kind: "none", label: "Asked" };
  if (status === "revoked") return { kind: "ask", label: "Ask again" };
  return { kind: "ask", label: "Ask for access" };
}
