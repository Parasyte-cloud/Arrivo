// Who on the staff can see and change which part of the ops console.
//
// Each console page is an "area". A person has one of three levels per area:
//   none    the page is hidden and its API refuses them
//   view    they can look but not change anything
//   manage  they can look and make changes
//
// Everyone starts from their role's preset below. The owner, or an admin they
// allowed to manage staff, can then raise or lower any area per person
// (users.staff_permissions, only the differences from the preset are stored).
// The owner always has everything.
//
// The API enforces this, not just the sidebar: every request a staff member
// makes to an area's endpoints is checked in middleware/auth.js. Endpoints that
// aren't listed here keep their old role checks.
//
// Pure, no database, so it can be tested on its own.

const LEVELS = ["none", "view", "manage"];
const rank = (level) => Math.max(0, LEVELS.indexOf(level));

// Order matters: the first matching rule wins, so the narrow paths sit above
// the broad ones they live under (wallet-adjust before riders, rides/live
// before rides).
//   work: true  means a change that only needs "view" because it's part of
//               doing the job, not managing the area (log a call, go on duty).
const AREAS = [
  { id: "ride-desk", label: "Ride Desk", rules: [
    { path: /^\/api\/staff\/(duty|rides\/\d+\/contact-log)\/?$/, work: true },
    { path: /^\/api\/calls\/staff\/ride\/\d+\/start\/?$/, work: true },
    // Not the number access log: that stays with its own head-of-support check.
    { path: /^\/api\/staff\/(rides|team|lead)(\/|$)/ },
    { path: /^\/api\/staff\/duty\/?$/ },
  ] },
  { id: "panics", label: "Panic Alerts", rules: [{ path: /^\/api\/admin\/panics(\/|$)/ }] },
  { id: "wallet", label: "Wallet", rules: [
    { path: /^\/api\/admin\/riders\/\d+\/wallet-adjust\/?$/ },
    { path: /^\/api\/admin\/wallet-transactions(\/|$)/ },
  ] },
  { id: "riders", label: "Riders", rules: [{ path: /^\/api\/admin\/(riders|waitlist)(\/|$)/ }] },
  { id: "drivers", label: "Drivers", rules: [{ path: /^\/api\/admin\/drivers(\/|$)/ }] },
  { id: "live-map", label: "Live Map", rules: [
    { path: /^\/api\/admin\/rides\/live\/?$/ },
    { path: /^\/api\/live-map(\/|$)/ },
  ] },
  { id: "trip-tracker", label: "Trip Tracker", rules: [{ path: /^\/api\/admin\/trips(\/|$)/ }] },
  { id: "rides", label: "Rides", rules: [
    { path: /^\/api\/admin\/(rides|ride-cancellations)(\/|$)/ },
    { path: /^\/api\/rides\/\d+\/fleet\/?$/ },
  ] },
  { id: "support", label: "Support Tickets", rules: [{ path: /^\/api\/support\/tickets(\/|$)/ }] },
  { id: "flight-issues", label: "Flight Issues", rules: [{ path: /^\/api\/admin\/flight-issues(\/|$)/ }] },
  { id: "vehicles", label: "Vehicles", rules: [{ path: /^\/api\/admin\/vehicles(\/|$)/ }] },
  { id: "memberships", label: "Memberships", rules: [{ path: /^\/api\/admin\/memberships(\/|$)/ }] },
  { id: "arrivo-express", label: "Arrivo Express", rules: [
    { path: /^\/api\/admin\/(config|family-plans|launch-promos|arrivo-share|partner-venues)(\/|$)/ },
  ] },
  { id: "express-pricing", label: "Express Pricing & Payouts", rules: [
    { path: /^\/api\/admin\/(express|cashouts)(\/|$)/ },
  ] },
  { id: "safety", label: "Trip Safety", rules: [{ path: /^\/api\/admin\/safety(\/|$)/ }] },
  { id: "analytics", label: "Analytics", rules: [{ path: /^\/api\/admin\/analytics(\/|$)/ }] },
  // The list, the history and one export at a time. Nothing deeper.
  { id: "exports", label: "Exports", rules: [{ path: /^\/api\/admin\/exports(\/[a-z-]+)?\/?$/ }] },
];
const AREA_IDS = AREAS.map((a) => a.id);
// How the Team page lists them: the same order as the console sidebar.
const DISPLAY_ORDER = [
  "ride-desk", "panics", "riders", "drivers", "rides", "support", "flight-issues", "vehicles",
  "memberships", "wallet", "arrivo-express", "express-pricing", "safety", "trip-tracker", "live-map", "analytics", "exports",
];

const all = (level) => Object.fromEntries(AREA_IDS.map((id) => [id, level]));

// Starting points. Support starts narrow on purpose: they see customer data,
// so they get what the job needs and more is granted per person.
const PRESETS = {
  admin: all("manage"),
  support: {
    ...all("none"),
    "ride-desk": "manage",
    // View, like before this existed. Closing tickets is granted per person.
    support: "view",
    panics: "view",
    riders: "view",
    rides: "view",
    // The exports router already gives support only the operational ones,
    // never the money exports or the history.
    exports: "view",
  },
  operations: {
    ...all("none"),
    "ride-desk": "view",
    panics: "view",
    drivers: "view",
    rides: "view",
    "flight-issues": "view",
    vehicles: "view",
    "trip-tracker": "view",
    "live-map": "view",
    analytics: "view",
    exports: "view",
  },
};

const STAFF_ROLES = Object.keys(PRESETS);

// Keeps only known areas and levels.
function cleanOverrides(value) {
  const out = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [id, level] of Object.entries(value)) {
    if (AREA_IDS.includes(id) && LEVELS.includes(level)) out[id] = level;
  }
  return out;
}

// The full map a person ends up with.
//   person: { role, is_owner, staff_permissions }
function effectivePermissions(person) {
  if (!person || !STAFF_ROLES.includes(person.role)) return null;
  if (person.is_owner) return all("manage");
  return { ...PRESETS[person.role], ...cleanOverrides(person.staff_permissions) };
}

// Only what differs from the role's preset, so a preset change later still
// reaches everyone who wasn't customised.
function diffFromPreset(role, wanted) {
  const preset = PRESETS[role] || {};
  const out = {};
  for (const [id, level] of Object.entries(cleanOverrides(wanted))) {
    if (preset[id] !== level) out[id] = level;
  }
  return out;
}

function findRule(path) {
  for (const area of AREAS) {
    for (const rule of area.rules) {
      if (rule.path.test(path)) return { area: area.id, work: !!rule.work };
    }
  }
  return null;
}

const READS = new Set(["GET", "HEAD", "OPTIONS"]);

// What a request needs.
//   { area, need: "view" | "manage" }, or null when the path isn't an area's.
function requirementFor(method, path) {
  const hit = findRule(path);
  if (!hit) return null;
  const need = READS.has(String(method).toUpperCase()) || hit.work ? "view" : "manage";
  return { area: hit.area, need };
}

// { ok, area, need, has } for a staff member's request.
function check(person, method, path) {
  const req = requirementFor(method, path);
  if (!req) return null;
  const perms = effectivePermissions(person) || {};
  const has = perms[req.area] || "none";
  return { ok: rank(has) >= rank(req.need), area: req.area, need: req.need, has };
}

module.exports = {
  LEVELS, AREAS, AREA_IDS, DISPLAY_ORDER, PRESETS, STAFF_ROLES,
  effectivePermissions, diffFromPreset, cleanOverrides, requirementFor, check, rank,
};
