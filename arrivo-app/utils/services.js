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
