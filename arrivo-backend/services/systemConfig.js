// Generic remotely-configurable key/value store, backing every "should be
// configurable, not hard-coded" parameter called out in the Arrivo Express
// engineering brief (Fair Fare's free-allowance minutes and per-minute
// rate, Family Plan's placeholder monthly prices, and anything future
// phases add -- Arrivo Share's fare split, Grotto's redemption rules).
// Deliberately a plain key/value table rather than a bespoke column per
// setting: Finance/Ops are still modelling several of these values (see
// the brief's "Before kickoff" slide), so new parameters need to be
// addable and editable from the admin dashboard without a schema change or
// a deploy.
const { pool } = require("../db/db");

// Values that ship with a real default so the product behaves sensibly
// before any admin has touched the config screen. Every one of these is
// still editable at runtime via PATCH /api/admin/config/:key -- this is a
// starting point, not a hard-coded limit.
const DEFAULTS = {
  // Fair Fare -- free traffic-delay allowance, in minutes, before an
  // overage charge starts. Threshold not yet chosen by Finance/Ops (brief
  // lists 10/15/20 as candidates); 15 is the brief's own worked example.
  fair_fare_free_allowance_minutes: "15",
  // Fair Fare -- naira charged per minute of delay beyond the free
  // allowance. Placeholder only -- the brief explicitly says this needs
  // modelling against historical trip data before launch.
  fair_fare_per_minute_naira: "50",
  // Family Plan -- placeholder monthly prices (naira) for the three
  // tiers. The brief marks these "not yet finalised" -- these numbers
  // exist so the feature is fully functional end-to-end, not because
  // Finance has signed off on them.
  family_plan_lite_price_naira: "15000",
  family_plan_plus_price_naira: "22000",
  family_plan_max_price_naira: "30000",
  // Arrivo Express Phase 2 -- 30-day launch promos. Percentages and the
  // Lucky Ride distance cap are the brief's own stated numbers (Early Bird
  // "up to 50%", Morning Commuter "20%"); the distance cap has no number
  // in the brief at all ("capped trip distance"), so 12km is a placeholder
  // pending Ops sign-off, same as the Phase 1 placeholders above.
  // launch_promos_enabled is the single kill switch for all three --
  // flip it to "false" to end the 30-day test without a deploy.
  launch_promos_enabled: "true",
  early_bird_discount_percent: "50",
  morning_commuter_discount_percent: "20",
  lucky_ride_max_distance_km: "12",
  // Arrivo Express Phase 3 -- Arrivo Share needs no config of its own (its
  // per-vehicle passenger cap already lives in services/fare.js's
  // MAX_PASSENGERS, shared with every other booking flow). Grotto x
  // RideArrivo's one real knob is how far a driver mid-reserved-ride stays
  // locked to that venue's area -- see GET /api/rides/available.
  grotto_program_enabled: "true",
  partner_venue_dispatch_radius_km: "5",
};

const DESCRIPTIONS = {
  fair_fare_free_allowance_minutes: "Fair Fare: minutes of traffic delay covered before an overage charge starts.",
  fair_fare_per_minute_naira: "Fair Fare: naira charged per minute of delay beyond the free allowance.",
  family_plan_lite_price_naira: "Family Plan Lite (2 members): monthly price in naira.",
  family_plan_plus_price_naira: "Family Plan Plus (3 members): monthly price in naira.",
  family_plan_max_price_naira: "Family Plan Max (5 members): monthly price in naira.",
  launch_promos_enabled: "Master switch for the 30-day launch promos (Early Bird, Morning Commuter, Lucky Ride). Set to \"false\" to turn all three off immediately.",
  early_bird_discount_percent: "Early Bird (4:30am-7:00am): percent off the fare, automatically applied.",
  morning_commuter_discount_percent: "Morning Commuter (7:00am-9:00am): percent off the fare, automatically applied.",
  lucky_ride_max_distance_km: "Midday Lucky Ride (12:00pm-1:00pm): maximum trip distance (km) eligible to enter the daily draw.",
  grotto_program_enabled: "Master switch for the Grotto x RideArrivo partner-venue program. Set to \"false\" to stop the area-lock behavior and hide partner venues immediately.",
  partner_venue_dispatch_radius_km: "Grotto x RideArrivo: while a driver has an active reserved pickup from a partner venue, only show them other rides within this many km of that venue.",
};

// Reads straight from the DB every call rather than caching -- these
// values change rarely (an admin editing a rate), and every call site here
// is already part of a request that's doing several other queries, so the
// extra round-trip is not a meaningful cost. Simplicity over a cache-
// invalidation bug.
async function getConfigNumber(key, fallback) {
  const result = await pool.query("SELECT value FROM system_config WHERE key = $1", [key]);
  const raw = result.rows[0]?.value ?? DEFAULTS[key] ?? fallback;
  const num = Number(raw);
  return Number.isFinite(num) ? num : fallback;
}

async function getConfigString(key, fallback) {
  const result = await pool.query("SELECT value FROM system_config WHERE key = $1", [key]);
  return result.rows[0]?.value ?? DEFAULTS[key] ?? fallback;
}

async function getConfigBool(key, fallback) {
  const raw = await getConfigString(key, fallback ? "true" : "false");
  return raw === "true";
}

// Returns every known config key with its current value (DB value if set,
// otherwise the shipped default) -- what the admin dashboard's config
// editor lists.
async function listConfig() {
  const result = await pool.query("SELECT key, value, updated_at, updated_by FROM system_config");
  const stored = new Map(result.rows.map((row) => [row.key, row]));
  return Object.keys(DEFAULTS).map((key) => ({
    key,
    value: stored.get(key)?.value ?? DEFAULTS[key],
    description: DESCRIPTIONS[key] || null,
    isDefault: !stored.has(key),
    updatedAt: stored.get(key)?.updated_at || null,
    updatedBy: stored.get(key)?.updated_by || null,
  }));
}

async function setConfig(key, value, adminUserId) {
  if (!Object.prototype.hasOwnProperty.call(DEFAULTS, key)) {
    throw new Error(`Unknown config key: ${key}`);
  }
  await pool.query(
    `INSERT INTO system_config (key, value, updated_at, updated_by) VALUES ($1, $2, now(), $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [key, String(value), adminUserId || null]
  );
}

module.exports = { getConfigNumber, getConfigString, getConfigBool, listConfig, setConfig, DEFAULTS, DESCRIPTIONS };
