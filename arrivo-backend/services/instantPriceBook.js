// The ArrivoExpress price book: fares that ops can change on a schedule,
// without a deploy, with a full history.
//
// Why this exists. Fares used to be constants in instantTiers.js, so every
// price change meant a code change, a review and a deploy. In a market where
// competitors move prices often, that is too slow to keep fares fair to both
// riders and drivers. Now ops publish a new price (effective now, or
// tomorrow morning) and the next quote picks it up.
//
// What protects against a typo. A fat-fingered extra zero would overcharge
// every rider, and a missing one would underpay every driver. Two guards:
//   1. Every number must be a sane whole amount, and the minimum fare cannot
//      be below the base fare.
//   2. A change of more than MAX_CHANGE_PCT (default 25%) on any one number
//      versus the price currently in force is refused unless the publisher
//      explicitly confirms it AND writes a note saying why.
//
// What happens if the database is unreachable. getActivePricing() returns
// null and quoting falls back to the code defaults, so a price book problem
// can never stop a rider from getting a fare.

const { listTiers, getTier } = require("./instantTiers");

const FIELDS = [
  ["baseFareNaira", "base_fare_naira"],
  ["perKmNaira", "per_km_naira"],
  ["perMinNaira", "per_min_naira"],
  ["minimumFareNaira", "minimum_fare_naira"],
];

class PriceBookError extends Error {
  constructor(message, status = 400, code = "INVALID_PRICE_BOOK", details = undefined) {
    super(message);
    this.name = "PriceBookError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function maxChangePct() {
  const v = Number(process.env.INSTANT_PRICE_MAX_CHANGE_PCT);
  return Number.isFinite(v) && v >= 1 && v <= 100 ? v : 25;
}

// Pure. The price currently in force for a tier if nothing is published:
// the code defaults.
function defaultPricing(tierKey) {
  const t = getTier(tierKey);
  if (!t) return null;
  return {
    baseFareNaira: t.baseFareNaira,
    perKmNaira: t.perKmNaira,
    perMinNaira: t.perMinNaira,
    minimumFareNaira: t.minimumFareNaira,
  };
}

// Pure. Checks one tier's proposed prices against its current prices and
// returns the cleaned entry. Throws PriceBookError with a message an admin can
// act on.
function validatePriceEntry(tierKey, proposed, current, { confirmLargeChange = false, note = "" } = {}) {
  if (!getTier(tierKey)) {
    throw new PriceBookError(`Unknown tier '${tierKey}'.`, 400, "UNKNOWN_TIER");
  }
  const clean = {};
  for (const [camel] of FIELDS) {
    const raw = proposed ? proposed[camel] : undefined;
    const n = Number(raw);
    if (raw === undefined || raw === null || raw === "" || !Number.isInteger(n)) {
      throw new PriceBookError(`${tierKey}.${camel} must be a whole number of naira.`, 400, "INVALID_PRICE");
    }
    clean[camel] = n;
  }
  if (clean.baseFareNaira <= 0 || clean.perKmNaira <= 0 || clean.minimumFareNaira <= 0 || clean.perMinNaira < 0) {
    throw new PriceBookError(`${tierKey}: base, per-km and minimum must be above zero.`, 400, "INVALID_PRICE");
  }
  if (clean.minimumFareNaira < clean.baseFareNaira) {
    throw new PriceBookError(`${tierKey}: the minimum fare cannot be lower than the base fare.`, 400, "INVALID_PRICE");
  }
  // Hard ceiling regardless of confirmation: no single number should ever be
  // this large in Lagos ride-hailing, so it is certainly a typo.
  const HARD_MAX = { baseFareNaira: 20000, perKmNaira: 5000, perMinNaira: 2000, minimumFareNaira: 50000 };
  for (const [camel] of FIELDS) {
    if (clean[camel] > HARD_MAX[camel]) {
      throw new PriceBookError(`${tierKey}.${camel} of ${clean[camel]} is above the allowed maximum of ${HARD_MAX[camel]}.`, 400, "PRICE_TOO_HIGH");
    }
  }

  const limit = maxChangePct();
  const big = [];
  for (const [camel] of FIELDS) {
    const before = current[camel];
    if (!before) continue;
    const pct = Math.abs(((clean[camel] - before) / before) * 100);
    if (pct > limit) big.push({ field: camel, from: before, to: clean[camel], changePct: Math.round(pct) });
  }
  if (big.length) {
    if (!confirmLargeChange) {
      throw new PriceBookError(
        `${tierKey}: this changes ${big.map((b) => `${b.field} by ${b.changePct}%`).join(", ")}, above the ${limit}% limit. ` +
          `If it is intended, resend with confirmLargeChange: true and a note explaining why.`,
        409,
        "PRICE_CHANGE_TOO_LARGE",
        { tier: tierKey, changes: big, limitPct: limit }
      );
    }
    if (String(note || "").trim().length < 10) {
      throw new PriceBookError(`${tierKey}: a large change needs a note of at least 10 characters saying why.`, 400, "NOTE_REQUIRED");
    }
  }
  return clean;
}

// ── Database side ──────────────────────────────────────────────────────

let cache = { at: 0, value: null };
const CACHE_MS = 30 * 1000;

function invalidateCache() {
  cache = { at: 0, value: null };
}

function getPool() {
  return require("../db/db").pool;
}

function rowToPricing(row) {
  return {
    baseFareNaira: row.base_fare_naira,
    perKmNaira: row.per_km_naira,
    perMinNaira: row.per_min_naira,
    minimumFareNaira: row.minimum_fare_naira,
  };
}

// Newest row per tier whose effective_from has passed. Returns
// { economy: {...}, ... } for tiers that have a published row (other tiers
// are simply absent, meaning "use the code default"), or null if the lookup
// failed. Cached for 30s so quoting does not hit the database for it.
async function getActivePricing(db) {
  if (!db && cache.value && Date.now() - cache.at < CACHE_MS) return cache.value;
  try {
    const result = await (db || getPool()).query(
      `SELECT DISTINCT ON (tier) tier, base_fare_naira, per_km_naira, per_min_naira, minimum_fare_naira, id
         FROM instant_price_book
        WHERE effective_from <= now()
        ORDER BY tier, effective_from DESC, id DESC`
    );
    const map = {};
    for (const row of result.rows) map[row.tier] = rowToPricing(row);
    if (!db) cache = { at: Date.now(), value: map };
    return map;
  } catch (error) {
    console.error("ArrivoExpress price book lookup failed, using defaults:", error.message);
    return null;
  }
}

// The price in force for one tier: published, else the code default.
function pricingForTier(map, tierKey) {
  return (map && map[tierKey]) || defaultPricing(tierKey);
}

// Publishes new prices for one or more tiers, all or nothing.
//   tiers: { economy: { baseFareNaira, perKmNaira, perMinNaira, minimumFareNaira }, ... }
async function publishPriceBook({ tiers, effectiveFrom, note, userId, confirmLargeChange = false, db }) {
  if (!tiers || typeof tiers !== "object" || !Object.keys(tiers).length) {
    throw new PriceBookError("tiers is required, for example { economy: { baseFareNaira: 600, ... } }.");
  }
  const when = effectiveFrom ? new Date(effectiveFrom) : new Date();
  if (Number.isNaN(when.getTime())) {
    throw new PriceBookError("effectiveFrom must be a valid date and time.", 400, "INVALID_DATE");
  }
  // Allow a few minutes of clock drift but no backdating: history must not be
  // rewritten, only added to.
  if (when.getTime() < Date.now() - 5 * 60 * 1000) {
    throw new PriceBookError("effectiveFrom cannot be in the past. Prices apply from now or a future time.", 400, "BACKDATED");
  }
  if (when.getTime() > Date.now() + 14 * 24 * 60 * 60 * 1000) {
    throw new PriceBookError("effectiveFrom cannot be more than 14 days ahead.", 400, "TOO_FAR_AHEAD");
  }

  const pool = db || getPool();
  // A checked-out client (it has release) is used as is; a pool lends us one.
  const borrowed = typeof pool.release !== "function" && typeof pool.connect === "function";
  const client = borrowed ? await pool.connect() : pool;
  try {
    await client.query("BEGIN");
    // Compare against what is in force at the moment the new price starts.
    const current = {};
    const active = await client.query(
      `SELECT DISTINCT ON (tier) tier, base_fare_naira, per_km_naira, per_min_naira, minimum_fare_naira
         FROM instant_price_book WHERE effective_from <= $1
        ORDER BY tier, effective_from DESC, id DESC`,
      [when]
    );
    for (const row of active.rows) current[row.tier] = rowToPricing(row);

    const inserted = [];
    for (const tierKey of Object.keys(tiers)) {
      const entry = validatePriceEntry(tierKey, tiers[tierKey], current[tierKey] || defaultPricing(tierKey), { confirmLargeChange, note });
      const r = await client.query(
        `INSERT INTO instant_price_book
           (tier, base_fare_naira, per_km_naira, per_min_naira, minimum_fare_naira, effective_from, note, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, tier, effective_from`,
        [tierKey, entry.baseFareNaira, entry.perKmNaira, entry.perMinNaira, entry.minimumFareNaira, when, note || null, userId || null]
      );
      inserted.push({ ...r.rows[0], ...entry });
    }
    await client.query("COMMIT");
    invalidateCache();
    return inserted;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    if (borrowed) client.release();
  }
}

async function listPriceHistory({ tier, limit = 50, db } = {}) {
  const result = await (db || getPool()).query(
    `SELECT b.id, b.tier, b.base_fare_naira AS "baseFareNaira", b.per_km_naira AS "perKmNaira",
            b.per_min_naira AS "perMinNaira", b.minimum_fare_naira AS "minimumFareNaira",
            b.effective_from AS "effectiveFrom", b.note, b.created_at AS "createdAt", u.name AS "publishedBy"
       FROM instant_price_book b
       LEFT JOIN users u ON u.id = b.created_by
      WHERE ($1::text IS NULL OR b.tier = $1)
      ORDER BY b.effective_from DESC, b.id DESC
      LIMIT $2`,
    [tier || null, Math.min(Math.max(Number(limit) || 50, 1), 200)]
  );
  return result.rows;
}

// What is in force right now for every tier, and which are still on the code
// defaults. For the admin "current prices" view.
async function currentPriceSheet(db) {
  const map = (await getActivePricing(db)) || {};
  return listTiers().map((t) => ({
    tier: t.key,
    source: map[t.key] ? "price_book" : "default",
    ...pricingForTier(map, t.key),
  }));
}

module.exports = {
  PriceBookError,
  validatePriceEntry,
  defaultPricing,
  getActivePricing,
  pricingForTier,
  publishPriceBook,
  listPriceHistory,
  currentPriceSheet,
  invalidateCache,
};
