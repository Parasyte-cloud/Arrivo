// The six RideArrivo tiers, as plain data.
//
// Each tier is its own small app living inside the rider app. The shell (Home)
// only knows this list: it shows a switcher, then mounts the panel the chosen
// tier supplies (tiers/panels.js). Adding a tier means adding one entry here
// and one panel, nothing else in the shell changes.
//
// Kept import-free on purpose so tiers/registry.test.js can load it with node.
//   kind "flow"     a tier with its own booking screens that already exist
//   kind "request"  a tier handled by the shared request form, confirmed by our team
//   gate            a rollout flag the shell must see as true before the tier shows

export const TIER_ORDER = ["ride", "express", "chauffer", "air", "boat", "removals"];

export const TIERS = {
  ride: {
    id: "ride",
    label: "RideArrivo",
    short: "Airport",
    tagline: "Airport pickups and drop-offs, timed to your flight.",
    icon: "airplane",
    kind: "flow",
    gate: null,
  },
  express: {
    id: "express",
    label: "ArrivoExpress",
    short: "Express",
    tagline: "A car in minutes, anywhere in the city.",
    icon: "flash",
    kind: "flow",
    gate: "expressEnabled",
  },
  chauffer: {
    id: "chauffer",
    label: "ArrivoChauffer",
    short: "Chauffer",
    tagline: "Your own driver for a day, a week or a month.",
    icon: "person",
    kind: "flow",
    gate: null,
  },
  air: {
    id: "air",
    label: "ArrivoAir",
    short: "Air",
    tagline: "Helicopter and private jet charters.",
    icon: "airplane-outline",
    kind: "request",
    gate: null,
  },
  boat: {
    id: "boat",
    label: "ArrivoBoat",
    short: "Boat",
    tagline: "Speedboats, ferry transfers and yachts on the lagoon.",
    icon: "boat",
    kind: "request",
    gate: null,
  },
  removals: {
    id: "removals",
    label: "ArrivoRemovals",
    short: "Removals",
    tagline: "A trained crew and a truck to move your home or office.",
    icon: "cube",
    kind: "request",
    gate: null,
  },
};

export function getTier(id) {
  return TIERS[id] || null;
}

// The tiers this rider can see right now. A gated tier stays hidden until its
// flag is true, so nobody lands on a feature that is switched off.
export function visibleTiers(flags) {
  const f = flags || {};
  return TIER_ORDER.filter((id) => !TIERS[id].gate || f[TIERS[id].gate] === true).map((id) => TIERS[id]);
}

// Which tier to open on. The one used last, if it is still on offer,
// otherwise RideArrivo, which is always on offer.
export function pickStartTier(lastUsedId, flags) {
  const visible = visibleTiers(flags);
  return visible.some((t) => t.id === lastUsedId) ? lastUsedId : "ride";
}
