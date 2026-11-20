// Every service a rider can order. A rider can use any of them and switch freely;
// it is the DRIVERS who are limited to the services Ops has granted them.
// `screen` is where the rider goes; the four request services share one screen.
export const SERVICES = [
  { id: "ride", screen: "Route" },
  { id: "express", screen: "ArrivoExpress" },
  { id: "chauffeur", screen: "Chauffeur" },
  { id: "campus", screen: "ServiceRequest", request: true },
  { id: "air", screen: "ServiceRequest", request: true },
  { id: "boat", screen: "ServiceRequest", request: true },
  { id: "removals", screen: "ServiceRequest", request: true },
];
export const REQUEST_SERVICES = SERVICES.filter((s) => s.request).map((s) => s.id);
export const isRequestService = (id) => REQUEST_SERVICES.includes(id);

// Moves to a service from anywhere. Replaces the current screen when the rider
// is already on a service screen, so switching does not pile up a back stack.
export function goToService(navigation, id, { replace = false } = {}) {
  const s = SERVICES.find((x) => x.id === id);
  if (!s) return;
  const params = s.request ? { service: id } : undefined;
  if (replace && navigation.replace) navigation.replace(s.screen, params);
  else navigation.navigate(s.screen, params);
}

// The home screen shows these in the same three groups as ridearrivo.com. This is the
// fallback; the server's list (GET /api/service-requests/catalogue) wins when it loads,
// so a card can be renamed, reordered or switched on without a store release.
// There is no separate "RideArrivo" card: Chauffeur and Airport transfer cover it.
export const HUB_GROUPS = ["ride", "move", "charter"];
export const HUB_DEFAULT = [
  { id: "express", group: "ride", flow: "express", enabled: true },
  { id: "transfer", group: "ride", flow: "route", enabled: true },
  { id: "schedule", group: "ride", flow: "route", enabled: true },
  { id: "campus", group: "ride", flow: "request", service: "campus", enabled: true },
  { id: "removals", group: "move", flow: "request", service: "removals", enabled: true },
  { id: "chauffeur", group: "charter", flow: "chauffeur", enabled: true },
  { id: "air", group: "charter", flow: "request", service: "air", enabled: true },
  { id: "boat", group: "charter", flow: "request", service: "boat", enabled: true },
];

// Opens the booking flow a card points at.
export function openHubCard(navigation, card) {
  if (card.flow === "express") return navigation.navigate("ArrivoExpress");
  if (card.flow === "chauffeur") return navigation.navigate("Chauffeur");
  if (card.flow === "request") return navigation.navigate("ServiceRequest", { service: card.service });
  if (card.id === "schedule") return navigation.navigate("Route", { presetBookingType: "one_way" });
  return navigation.navigate("Route");
}
