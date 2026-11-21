// Small pure helpers for the map-first Express and Campus screens (the same sheet as the web).
// Kept free of React so they can be tested with plain node: node utils/mapFirst.test.js

// A place is { address, lat, lng } or null. "No place yet" is null, never an empty object.
export function placeOf(address, pt) {
  const a = String(address || "").trim();
  if (!a && !pt) return null;
  return { address: a, lat: pt && pt.lat != null ? pt.lat : null, lng: pt && pt.lng != null ? pt.lng : null };
}

// The up and down arrows between pickup and destination: swap the two, text and map point together.
export function swapPlaces(pickup, destination) {
  return { pickup: destination || null, destination: pickup || null };
}

// A place is usable for a quote only once it has a point on the map, not just typed text.
export function isResolved(place) {
  return !!place && place.lat != null && place.lng != null && Number.isFinite(Number(place.lat)) && Number.isFinite(Number(place.lng));
}

// The presets the scheduled booking screen (Route) reads, so a rider who flips to "Schedule" does not type it twice.
export function routePresets(pickup, destination) {
  const p = pickup || null, d = destination || null;
  return {
    presetPickupAddress: p ? p.address : undefined, presetPickupLat: p && p.lat != null ? p.lat : undefined, presetPickupLng: p && p.lng != null ? p.lng : undefined,
    presetDestinationAddress: d ? d.address : undefined, presetDestinationLat: d && d.lat != null ? d.lat : undefined, presetDestinationLng: d && d.lng != null ? d.lng : undefined,
  };
}

// Campus: "Going to school" fills the destination with the school, "Coming home" fills the pickup.
export function applySchool(direction, current, school) {
  if (direction === "from") return { pickup: school, destination: current.destination || null };
  return { pickup: current.pickup || null, destination: school };
}

// Flipping the direction moves the school to the other end, which is what the web does: the rider keeps the
// school they chose and only says which way they are going.
export function flipDirection(direction, current) {
  const next = direction === "from" ? "to" : "from";
  const { pickup, destination } = swapPlaces(current.pickup, current.destination);
  return { direction: next, pickup, destination };
}

// A school shortcut is a search phrase. The first suggestion is the one the web picks too.
export function firstPrediction(predictions) {
  return Array.isArray(predictions) && predictions.length && predictions[0] && predictions[0].placeId ? predictions[0] : null;
}

// The shortcuts, same list and wording as the web (tiers/campus/tier.mjs in the engine). They are search phrases,
// not coordinates, so a gate that moves is fixed by the search result and not by an app release.
export const CAMPUS_SCHOOLS = [
  { key: "unilag", label: "UNILAG main gate", query: "University of Lagos main gate, Akoka, Lagos" },
  { key: "lasu", label: "LASU, Ojo", query: "Lagos State University main gate, Ojo, Lagos" },
  { key: "yabatech", label: "Yabatech", query: "Yaba College of Technology, Yaba, Lagos" },
  { key: "covenant", label: "Covenant University", query: "Covenant University, Ota, Ogun State" },
  { key: "babcock", label: "Babcock University", query: "Babcock University, Ilishan-Remo, Ogun State" },
];
