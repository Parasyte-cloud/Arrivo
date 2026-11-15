// What a rider sees on the home screen, in the same three groups the website uses
// (Ride, Move, Charter). Kept on the server so a card can be renamed, reordered or
// switched on and off without a new store release. `flow` tells the app which
// booking flow to open; the app falls back to this same list if it cannot reach us.
// Riders can use every service; the DRIVER side is limited by tier access, not here.
function buildCatalogue({ expressEnabled }) {
  return [
    { id: "express", group: "ride", flow: "express", enabled: !!expressEnabled },
    { id: "transfer", group: "ride", flow: "route", enabled: true },
    { id: "campus", group: "ride", flow: "request", service: "campus", minAge: 16, enabled: true },
    { id: "removals", group: "move", flow: "request", service: "removals", enabled: true },
    { id: "chauffeur", group: "charter", flow: "chauffeur", enabled: true },
    { id: "air", group: "charter", flow: "request", service: "air", enabled: true },
    { id: "boat", group: "charter", flow: "request", service: "boat", enabled: true },
  ];
}
module.exports = { buildCatalogue };
