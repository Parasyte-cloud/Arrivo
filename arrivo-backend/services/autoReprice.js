// Automatic repricing for ArrivoExpress, with guard rails.
//
// The idea: if our fare for the same trip is consistently above (or below)
// what competitors charge, nudge our price toward them in SMALL steps, at most
// once a day per tier, and only when the evidence is strong. It is OFF until
// an admin turns on express_auto_reprice_enabled, and every change it makes
// is a normal price book row (note starts with "AUTO:") so it shows in the
// history and can be reverted by publishing a price by hand.
//
// A price moves only when ALL of these hold for a tier:
//   1. Enough evidence: at least AUTO_REPRICE_MIN_SAMPLES samples since the
//      last price change for that tier (older samples were measured against
//      a different price, so they would double-count).
//   2. Independent agreement: at least AUTO_REPRICE_MIN_SOURCES different
//      competitors (each with 2+ samples) all say the same direction.
//      One odd source cannot move the price alone.
//   3. Not in cooldown: no automatic change to this tier in the last
//      AUTO_REPRICE_COOLDOWN_HOURS (default 24).
//   4. Small step: the move is capped at AUTO_REPRICE_MAX_STEP_PCT (default 5%).
//   5. Inside the band: the result stays between AUTO_REPRICE_BAND_MIN_PCT
//      (70) and AUTO_REPRICE_BAND_MAX_PCT (150) of the code default price.
//      Automation can drift prices, never run them away.
// Anything else is a "hold" with the reason recorded.


// Required lazily so the pure rules below can be unit tested with no database.
const getConfigBool = (...a) => require("./systemConfig").getConfigBool(...a);

const FIELDS = ["baseFareNaira", "perKmNaira", "perMinNaira", "minimumFareNaira"];

function num(name, fallback, min, max) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= min && v <= max ? v : fallback;
}

function settings() {
  return {
    maxStepPct: num("AUTO_REPRICE_MAX_STEP_PCT", 5, 1, 15),
    minSamples: num("AUTO_REPRICE_MIN_SAMPLES", 8, 3, 1000),
    minSources: num("AUTO_REPRICE_MIN_SOURCES", 2, 1, 4),
    windowDays: num("AUTO_REPRICE_WINDOW_DAYS", 3, 1, 30),
    cooldownHours: num("AUTO_REPRICE_COOLDOWN_HOURS", 24, 1, 24 * 14),
    bandMinPct: num("AUTO_REPRICE_BAND_MIN_PCT", 70, 10, 100),
    bandMaxPct: num("AUTO_REPRICE_BAND_MAX_PCT", 150, 100, 400),
    tolerancePct: 8,
  };
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Pure. Decides what to do for ONE tier.
//   input: {
//     tier, samples: [{ source, observed_fare_naira, our_fare_naira }]  (since last change),
//     current: {4 fields}, defaults: {4 fields},
//     lastAutoChangeAt: Date|null, now: Date
//   }
// Returns { tier, action: 'change' | 'hold', reason, ... } and, for 'change',
// { changePct, proposed }.
function planTier(input, opts = settings()) {
  const { tier, samples = [], current, defaults, lastAutoChangeAt = null, now = new Date() } = input;
  const hold = (reason, extra = {}) => ({ tier, action: "hold", reason, samples: samples.length, ...extra });

  if (lastAutoChangeAt && now.getTime() - new Date(lastAutoChangeAt).getTime() < opts.cooldownHours * 3600 * 1000) {
    return hold("cooldown");
  }
  if (samples.length < opts.minSamples) return hold("not_enough_samples");

  const bySource = {};
  for (const s of samples) {
    (bySource[s.source] = bySource[s.source] || []).push(Number(s.our_fare_naira) / Number(s.observed_fare_naira));
  }
  const strong = Object.entries(bySource).filter(([, r]) => r.length >= 2);
  if (strong.length < opts.minSources) return hold("not_enough_sources");

  const tol = opts.tolerancePct / 100;
  const dirs = strong.map(([, r]) => {
    const m = median(r);
    return m > 1 + tol ? "above" : m < 1 - tol ? "below" : "in_line";
  });
  if (dirs.some((d) => d === "in_line") || new Set(dirs).size > 1) {
    return hold(new Set(dirs).size > 1 ? "sources_disagree" : "in_line");
  }

  const overall = median(samples.map((s) => Number(s.our_fare_naira) / Number(s.observed_fare_naira)));
  const parityPct = (1 / overall - 1) * 100;
  const changePct = Math.max(-opts.maxStepPct, Math.min(opts.maxStepPct, Math.round(parityPct)));
  if (changePct === 0) return hold("in_line");

  const proposed = {};
  for (const f of FIELDS) proposed[f] = Math.max(1, Math.round((current[f] * (100 + changePct)) / 100));
  if (proposed.minimumFareNaira < proposed.baseFareNaira) proposed.minimumFareNaira = proposed.baseFareNaira;

  for (const f of FIELDS) {
    const lo = Math.ceil((defaults[f] * opts.bandMinPct) / 100);
    const hi = Math.floor((defaults[f] * opts.bandMaxPct) / 100);
    if (proposed[f] < lo || proposed[f] > hi) {
      return hold("outside_band", { field: f, wouldBe: proposed[f], bandLow: lo, bandHigh: hi });
    }
  }
  const unchanged = FIELDS.every((f) => proposed[f] === current[f]);
  if (unchanged) return hold("rounds_to_no_change");

  return { tier, action: "change", reason: changePct > 0 ? "below_market" : "above_market", samples: samples.length, medianRatio: Math.round(overall * 100) / 100, changePct, from: { ...current }, proposed };
}

function getPool() {
  return require("../db/db").pool;
}

// The samples that count for one tier: those logged since its last price
// change (older ones were measured against a different price), within the
// window. Also when it was last changed automatically.
async function loadEvidence(pool, tierKey, now, opts) {
  const last = await pool.query(
    `SELECT max(effective_from) FILTER (WHERE note LIKE 'AUTO:%') AS last_auto,
            max(effective_from) FILTER (WHERE effective_from <= $2) AS last_any
       FROM instant_price_book WHERE tier = $1`,
    [tierKey, now]
  );
  const lastAuto = last.rows[0].last_auto;
  const lastAny = last.rows[0].last_any;
  const windowStart = new Date(now.getTime() - opts.windowDays * 86400000);
  const since = lastAny && new Date(lastAny) > windowStart ? new Date(lastAny) : windowStart;
  const s = await pool.query(
    `SELECT source, observed_fare_naira, our_fare_naira
       FROM instant_price_samples WHERE tier = $1 AND created_at >= $2`,
    [tierKey, since]
  );
  return { samples: s.rows, lastAuto, since };
}

// Pure. What is still missing before a tier can move, in plain words.
function coverageForTier(tier, samples, opts) {
  const bySource = {};
  for (const x of samples) bySource[x.source] = (bySource[x.source] || 0) + 1;
  const strongSources = Object.values(bySource).filter((n) => n >= 2).length;
  const needSamples = Math.max(opts.minSamples - samples.length, 0);
  const needSources = Math.max(opts.minSources - strongSources, 0);
  const missing = [];
  if (needSamples) missing.push(`${needSamples} more sample${needSamples === 1 ? "" : "s"}`);
  if (needSources) missing.push(`${needSources} more competitor${needSources === 1 ? "" : "s"} with at least 2 samples`);
  return { tier, samples: samples.length, bySource, needSamples, needSources, ready: missing.length === 0, missing: missing.join(" and ") };
}

// What the admin screen shows: how close each tier is to having enough data.
async function coverage({ db, now = new Date() } = {}) {
  const pool = db || getPool();
  const opts = settings();
  const { listTiers } = require("./instantTiers");
  const tiers = [];
  for (const t of listTiers()) {
    const { samples } = await loadEvidence(pool, t.key, now, opts);
    tiers.push(coverageForTier(t.key, samples, opts));
  }
  return { windowDays: opts.windowDays, minSamples: opts.minSamples, minSources: opts.minSources, tiers };
}

// Reads the evidence and builds a plan for every tier. Pure reads.
async function planAutoReprice({ db, now = new Date() } = {}) {
  const pool = db || getPool();
  const opts = settings();
  const { listTiers } = require("./instantTiers");
  const { getActivePricing, pricingForTier, defaultPricing } = require("./instantPriceBook");
  const active = await getActivePricing(pool);
  if (active === null) return { opts, tiers: [], error: "price_book_unavailable" };

  const tiers = [];
  for (const t of listTiers()) {
    const { samples, lastAuto } = await loadEvidence(pool, t.key, now, opts);
    tiers.push(
      planTier({
        tier: t.key,
        samples,
        current: pricingForTier(active, t.key),
        defaults: defaultPricing(t.key),
        lastAutoChangeAt: lastAuto,
        now,
      }, opts)
    );
  }
  return { opts, tiers };
}

async function logEvent(db, action, detail, runDate = null) {
  return db.query(
    "INSERT INTO express_automation_log (kind, action, run_date, detail) VALUES ('reprice', $1, $2, $3::jsonb)",
    [action, runDate, JSON.stringify(detail || {})]
  );
}

// Plans and applies. One tier failing never blocks the others.
//   mode: 'auto' (scheduler, needs the switch on) | 'manual' (admin pressed apply)
async function applyAutoReprice({ db, mode = "auto", adminId = null, now = new Date() } = {}) {
  const pool = db || getPool();
  if (mode === "auto" && !(await getConfigBool("express_auto_reprice_enabled", false))) {
    return { ran: false, reason: "disabled", applied: [], held: [] };
  }
  const client = pool.connect ? await pool.connect() : pool;
  const applied = [];
  const held = [];
  try {
    // One run at a time across all server instances.
    const lock = await client.query("SELECT pg_try_advisory_lock(7710042) AS ok");
    if (!lock.rows[0].ok) return { ran: false, reason: "busy", applied, held };
    try {
      const plan = await planAutoReprice({ db: client, now });
      if (plan.error) return { ran: false, reason: plan.error, applied, held };
      const { publishPriceBook } = require("./instantPriceBook");
      for (const t of plan.tiers) {
        if (t.action !== "change") {
          held.push(t);
          continue;
        }
        try {
          const note = `AUTO: ${t.changePct > 0 ? "+" : ""}${t.changePct}% (${t.reason}, median ratio ${t.medianRatio}, ${t.samples} samples)`;
          await publishPriceBook({ tiers: { [t.tier]: t.proposed }, note, userId: adminId, db: client });
          applied.push(t);
        } catch (error) {
          held.push({ tier: t.tier, action: "hold", reason: "publish_refused", message: error.message });
        }
      }
      await logEvent(client, "applied", { mode, adminId, applied, held });
      return { ran: true, applied, held };
    } finally {
      await client.query("SELECT pg_advisory_unlock(7710042)").catch(() => {});
    }
  } finally {
    if (client.release) client.release();
  }
}

// The scheduler entry. Claims today's run exactly once (even with several
// servers), only after 05:00 Lagos so it works on a full night of samples.
async function runDailyReprice({ db, now = new Date() } = {}) {
  const pool = db || getPool();
  if (!(await getConfigBool("express_auto_reprice_enabled", false))) return { ran: false, reason: "disabled" };
  const { lagosMinutesOfDay, lagosDateString } = require("./fare");
  if (lagosMinutesOfDay(now) < 5 * 60) return { ran: false, reason: "too_early" };
  const claim = await pool.query(
    `INSERT INTO express_automation_log (kind, action, run_date, detail)
     VALUES ('reprice', 'run', $1, '{}'::jsonb)
     ON CONFLICT DO NOTHING RETURNING id`,
    [lagosDateString(now)]
  );
  if (!claim.rowCount) return { ran: false, reason: "already_ran_today" };
  return applyAutoReprice({ db: pool, mode: "auto", now });
}

module.exports = { settings, planTier, coverage, coverageForTier, planAutoReprice, applyAutoReprice, runDailyReprice };
