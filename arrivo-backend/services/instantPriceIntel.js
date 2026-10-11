// Competitor price tracking for ArrivoExpress.
//
// The goal is a price that works for BOTH sides: low enough that riders pick
// us over Bolt, Uber and inDrive for the same trip, high enough that a driver
// clears fuel and maintenance and stays. Neither can be judged from inside the
// company, so ops log what the same trip costs elsewhere (a few samples a day)
// and this turns the log into a plain answer per tier: above market, in line,
// or below market, with a suggested adjustment.
//
// This module only SUGGESTS. A person can publish the new price
// (instantPriceBook.js, where the change-size guard applies), or switch on the
// guarded automatic repricing (autoReprice.js), which reads the same samples
// and moves prices in small, capped steps.

const { listTiers } = require("./instantTiers");
const { baselineFare } = require("./instantFare");
const { getActivePricing, pricingForTier } = require("./instantPriceBook");

const SOURCES = ["bolt", "uber", "indrive", "other"];
const MIN_SAMPLES = 5;

class PriceSampleError extends Error {
  constructor(message, status = 400, code = "INVALID_PRICE_SAMPLE") {
    super(message);
    this.name = "PriceSampleError";
    this.status = status;
    this.code = code;
  }
}

// Pure. Cleans one logged observation.
function validateSample(input = {}, now = new Date()) {
  const tier = String(input.tier || "").toLowerCase();
  if (!listTiers().some((t) => t.key === tier)) {
    throw new PriceSampleError(`tier must be one of: ${listTiers().map((t) => t.key).join(", ")}`);
  }
  const source = String(input.source || "").toLowerCase();
  if (!SOURCES.includes(source)) {
    throw new PriceSampleError(`source must be one of: ${SOURCES.join(", ")}`);
  }
  const period = String(input.period || "day").toLowerCase();
  if (!["day", "night"].includes(period)) {
    throw new PriceSampleError("period must be 'day' or 'night'");
  }
  const distanceKm = Number(input.distanceKm);
  const durationMin = Number(input.durationMin);
  const observedFareNaira = Number(input.observedFareNaira);
  if (!Number.isFinite(distanceKm) || distanceKm < 0.5 || distanceKm > 150) {
    throw new PriceSampleError("distanceKm must be between 0.5 and 150");
  }
  if (!Number.isFinite(durationMin) || durationMin < 1 || durationMin > 360) {
    throw new PriceSampleError("durationMin must be between 1 and 360");
  }
  if (!Number.isInteger(observedFareNaira) || observedFareNaira < 300 || observedFareNaira > 500000) {
    throw new PriceSampleError("observedFareNaira must be a whole amount between 300 and 500000");
  }
  const observedOn = String(input.observedOn || now.toISOString().slice(0, 10));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(observedOn) || Number.isNaN(Date.parse(observedOn))) {
    throw new PriceSampleError("observedOn must be a date like 2026-10-09");
  }
  if (Date.parse(observedOn) > now.getTime() + 24 * 60 * 60 * 1000) {
    throw new PriceSampleError("observedOn cannot be in the future");
  }
  const routeLabel = input.routeLabel ? String(input.routeLabel).slice(0, 200) : null;
  return { tier, source, period, distanceKm, durationMin, observedFareNaira, observedOn, routeLabel };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Pure. rows: [{ tier, source, observed_fare_naira, our_fare_naira }]
// For each tier: how many samples, the median of (our fare / their fare), and
// a verdict. Median not mean, so one odd screenshot (a surge, a promo) cannot
// swing the answer.
function buildComparison(rows, { tolerancePct = 8, maxSuggestPct = 20 } = {}) {
  return listTiers().map((tierInfo) => {
    const mine = rows.filter((r) => r.tier === tierInfo.key);
    const ratios = mine.map((r) => Number(r.our_fare_naira) / Number(r.observed_fare_naira));
    const bySource = {};
    for (const src of SOURCES) {
      const part = mine.filter((r) => r.source === src);
      if (part.length) {
        bySource[src] = {
          samples: part.length,
          medianRatio: round2(median(part.map((r) => Number(r.our_fare_naira) / Number(r.observed_fare_naira)))),
        };
      }
    }
    if (mine.length < MIN_SAMPLES) {
      return {
        tier: tierInfo.key,
        samples: mine.length,
        verdict: "not_enough_data",
        medianRatio: mine.length ? round2(median(ratios)) : null,
        suggestedChangePct: null,
        bySource,
        note: `Need at least ${MIN_SAMPLES} samples for a reliable comparison.`,
      };
    }
    const medianRatio = median(ratios);
    let verdict = "in_line";
    if (medianRatio > 1 + tolerancePct / 100) verdict = "above_market";
    else if (medianRatio < 1 - tolerancePct / 100) verdict = "below_market";
    // The change that would bring our median to parity, capped so the
    // suggestion never invites a jump the price book guard would refuse.
    const parityPct = (1 / medianRatio - 1) * 100;
    const suggestedChangePct =
      verdict === "in_line" ? 0 : Math.max(-maxSuggestPct, Math.min(maxSuggestPct, Math.round(parityPct)));
    return {
      tier: tierInfo.key,
      samples: mine.length,
      verdict,
      medianRatio: round2(medianRatio),
      suggestedChangePct,
      bySource,
      note:
        verdict === "above_market"
          ? "We are dearer than the same trip elsewhere. Riders will compare and may choose them."
          : verdict === "below_market"
            ? "We are cheaper than elsewhere. Check this still leaves drivers a fair margin before moving."
            : "In line with the market.",
    };
  });
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function getPool() {
  return require("../db/db").pool;
}

async function logSample(input, userId, db) {
  const sample = validateSample(input);
  const pricing = pricingForTier(await getActivePricing(db), sample.tier);
  const ourFare = baselineFare(pricing, sample.distanceKm, sample.durationMin, { night: sample.period === "night" });
  const result = await (db || getPool()).query(
    `INSERT INTO instant_price_samples
       (observed_on, period, source, tier, route_label, distance_km, duration_min,
        observed_fare_naira, our_fare_naira, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id, observed_on AS "observedOn", period, source, tier, route_label AS "routeLabel",
               distance_km AS "distanceKm", duration_min AS "durationMin",
               observed_fare_naira AS "observedFareNaira", our_fare_naira AS "ourFareNaira"`,
    [sample.observedOn, sample.period, sample.source, sample.tier, sample.routeLabel, sample.distanceKm,
     sample.durationMin, sample.observedFareNaira, ourFare, userId || null]
  );
  return result.rows[0];
}

// Logs many samples at once, all or nothing. A bad row stops the import and
// says which row, so a half-pasted sheet never leaves half its data behind.
//   rows: array of the same objects validateSample accepts
const MAX_BULK = 100;
async function logSamples(rows, userId, db) {
  if (!Array.isArray(rows) || !rows.length) throw new PriceSampleError("Send at least one row.");
  if (rows.length > MAX_BULK) throw new PriceSampleError(`Send at most ${MAX_BULK} rows at a time.`);
  const clean = [];
  const errors = [];
  rows.forEach((r, i) => {
    try { clean.push(validateSample(r)); } catch (e) { errors.push({ row: i + 1, error: e.message }); }
  });
  if (errors.length) {
    const err = new PriceSampleError(`Row ${errors[0].row}: ${errors[0].error}${errors.length > 1 ? ` (and ${errors.length - 1} more row${errors.length === 2 ? "" : "s"} with problems)` : ""}. Nothing was saved.`, 400, "INVALID_PRICE_SAMPLE_ROWS");
    err.details = errors;
    throw err;
  }
  const pool = db || getPool();
  const active = await getActivePricing(pool);
  const client = pool.release ? pool : await pool.connect();
  try {
    await client.query("BEGIN");
    for (const s of clean) {
      const ourFare = baselineFare(pricingForTier(active, s.tier), s.distanceKm, s.durationMin, { night: s.period === "night" });
      await client.query(
        `INSERT INTO instant_price_samples
           (observed_on, period, source, tier, route_label, distance_km, duration_min, observed_fare_naira, our_fare_naira, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [s.observedOn, s.period, s.source, s.tier, s.routeLabel, s.distanceKm, s.durationMin, s.observedFareNaira, ourFare, userId || null]
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    if (!pool.release && client.release) client.release();
  }
  return { saved: clean.length };
}

async function comparison({ days = 7, db } = {}) {
  const window = Math.min(Math.max(Number(days) || 7, 1), 90);
  const result = await (db || getPool()).query(
    `SELECT tier, source, observed_fare_naira, our_fare_naira
       FROM instant_price_samples
      WHERE observed_on >= (now() AT TIME ZONE 'Africa/Lagos')::date - $1::int`,
    [window]
  );
  return { days: window, tiers: buildComparison(result.rows) };
}

module.exports = {
  PriceSampleError,
  SOURCES,
  MIN_SAMPLES,
  validateSample,
  buildComparison,
  logSample,
  logSamples,
  MAX_BULK,
  comparison,
};
