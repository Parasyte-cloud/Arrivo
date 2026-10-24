// The console's view of who can see and change what. The backend decides
// (arrivo-backend/services/staffAccess.js); this only shapes the screen.

export const PAGE_IDS = [
  "ride-desk", "panics", "riders", "drivers", "rides", "support", "flight-issues",
  "vehicles", "memberships", "wallet", "trip-tracker", "live-map", "analytics", "arrivo-express",
  "express-pricing", "safety", "exports",
];

const LEVEL_RANK = { none: 0, view: 1, manage: 2 };

const OPERATIONS_PAGES = ["ride-desk", "panics", "drivers", "rides", "flight-issues", "vehicles", "trip-tracker", "live-map", "analytics", "exports"];

// What each role had before per-person permissions existed. Only used if the
// backend this console talks to doesn't have /api/staff/access yet.
export function legacyAccess(role) {
  const perms = {};
  for (const id of PAGE_IDS) {
    if (role === "admin") perms[id] = "manage";
    else if (role === "operations") perms[id] = OPERATIONS_PAGES.includes(id) ? "view" : "none";
    else if (role === "support") perms[id] = ["express-pricing", "safety"].includes(id) ? "none" : "view";
    else perms[id] = "none";
  }
  return { role, isOwner: false, canManageStaff: false, canSeeTeam: role === "admin", permissions: perms, legacy: true };
}

export function canDo(access, area, level = "view") {
  const has = access && access.permissions ? access.permissions[area] || "none" : "none";
  return (LEVEL_RANK[has] || 0) >= (LEVEL_RANK[level] || 0);
}
