// A small per-key request limiter held in memory, for routes that spend a paid quota (flight lookups).
// One server process, so the count resets on restart and is not shared between instances. That is
// enough to stop a script draining a provider quota; it is not a security boundary.
function createLimiter({ max, windowMs, now = () => Date.now() }) {
  const hits = new Map();
  return function allow(key) {
    const t = now();
    const recent = (hits.get(key) || []).filter((at) => t - at < windowMs);
    if (recent.length >= max) { hits.set(key, recent); return false; }
    recent.push(t);
    hits.set(key, recent);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.length || t - v[v.length - 1] >= windowMs) hits.delete(k);
    return true;
  };
}
module.exports = { createLimiter };
