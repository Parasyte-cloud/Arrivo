// A rate-limit counter kept in Postgres so every backend instance shares it.
//
// express-rate-limit keeps counts in the memory of one process by default. Run two
// Render instances and a user can order the limit's worth on each, so the real limit
// is doubled (and the Google-spending routes lose half their protection). This store
// puts the count in one row per (limiter, key), updated atomically by one statement,
// so two servers incrementing at once cannot lose a hit.
//
// If the database cannot be reached the store does NOT block anyone and does not
// throw: it counts in memory for that instance until the database is back. A limiter
// that can take the booking flow down is worse than a limiter that is briefly loose.
//
// Implements the express-rate-limit v8 store interface.

const MEMORY_SWEEP_MS = 60 * 1000;
const CLEANUP_MS = 10 * 60 * 1000;

class PgRateLimitStore {
  // pool: a pg Pool. name: unique per limiter (two limiters must not share counts).
  constructor({ pool, name }) {
    if (!pool || !name) throw new Error("PgRateLimitStore needs a pool and a name");
    this.pool = pool;
    this.name = name;
    this.windowMs = 60 * 1000;
    this.memory = new Map();
    this.localKeys = false; // counts are shared, so the library must not treat them as per process
    this.lastSweep = 0;
  }

  init(options) {
    this.windowMs = options.windowMs;
    if (!PgRateLimitStore.cleanupStarted) {
      PgRateLimitStore.cleanupStarted = true;
      const timer = setInterval(() => {
        this.pool.query("DELETE FROM rate_limit_hits WHERE reset_at < now() - interval '1 hour'").catch(() => {});
      }, CLEANUP_MS);
      if (timer.unref) timer.unref();
    }
  }

  async increment(key) {
    try {
      const { rows } = await this.pool.query(
        `INSERT INTO rate_limit_hits (store, key, hits, reset_at)
         VALUES ($1, $2, 1, now() + ($3 * interval '1 millisecond'))
         ON CONFLICT (store, key) DO UPDATE SET
           hits = CASE WHEN rate_limit_hits.reset_at <= now() THEN 1 ELSE rate_limit_hits.hits + 1 END,
           reset_at = CASE WHEN rate_limit_hits.reset_at <= now() THEN now() + ($3 * interval '1 millisecond') ELSE rate_limit_hits.reset_at END
         RETURNING hits, reset_at`,
        [this.name, String(key), this.windowMs]
      );
      return { totalHits: rows[0].hits, resetTime: new Date(rows[0].reset_at) };
    } catch (err) {
      console.error(`[rate-limit:${this.name}] database unavailable, counting in memory:`, err.message);
      return this.memoryIncrement(String(key));
    }
  }

  async decrement(key) {
    try {
      await this.pool.query("UPDATE rate_limit_hits SET hits = GREATEST(hits - 1, 0) WHERE store = $1 AND key = $2", [this.name, String(key)]);
    } catch (_) {
      const m = this.memory.get(String(key));
      if (m && m.hits > 0) m.hits--;
    }
  }

  async resetKey(key) {
    this.memory.delete(String(key));
    try {
      await this.pool.query("DELETE FROM rate_limit_hits WHERE store = $1 AND key = $2", [this.name, String(key)]);
    } catch (_) { /* nothing to reset if the database is away */ }
  }

  memoryIncrement(key) {
    const now = Date.now();
    if (now - this.lastSweep > MEMORY_SWEEP_MS) {
      this.lastSweep = now;
      for (const [k, v] of this.memory) if (v.resetAt <= now) this.memory.delete(k);
    }
    let m = this.memory.get(key);
    if (!m || m.resetAt <= now) { m = { hits: 0, resetAt: now + this.windowMs }; this.memory.set(key, m); }
    m.hits++;
    return { totalHits: m.hits, resetTime: new Date(m.resetAt) };
  }
}

module.exports = { PgRateLimitStore };
