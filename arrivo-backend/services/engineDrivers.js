// Drivers who signed up through the new ArrivoExpress engine (arrivo-everywhere), read-only.
// They live in the engine's own database, so ArrivoOps asks the engine for them. This never
// writes to the engine. It fails soft: if the engine is not set up or is down, the older
// drivers still load and the screen says why the new ones are missing.
//
// Needs, on the ArrivoOps backend service:
//   ARRIVO_ENGINE_URL        e.g. https://arrivo-everywhere.onrender.com
//   ARRIVO_ENGINE_OPS_TOKEN  the same value as ARRIVO_OPS_TOKEN on the engine

const TTL_MS = 15_000;
let cache = { at: 0, value: null };

function mapDriver(row, now = Date.now()) {
  const d = row.driver || {};
  const p = row.presence || null;
  const online = Boolean(p && p.online && p.expires_at && Date.parse(p.expires_at) > now);
  const v = d.vehicle || {};
  return {
    id: `engine:${d.id}`,
    source: "engine",
    name: d.displayName || "Driver",
    email: null,
    phone: null,
    user_id: null,
    make_model: [v.make, v.model, v.year].filter(Boolean).join(" ") || null,
    plate_number: v.plate || null,
    vehicle_type: v.category || null,
    license_number: null,
    lasdri_number: null,
    created_at: d.createdAt || null,
    is_verified: d.status === "approved",
    is_online: online,
    tier: "express",
    archived_at: null,
    verification_stage: d.verificationStage || d.kycStatus || null,
  };
}

async function fetchEngineDrivers({ fetchImpl = fetch, env = process.env, now = Date.now() } = {}) {
  const base = String(env.ARRIVO_ENGINE_URL || "").replace(/\/$/, "");
  const token = env.ARRIVO_ENGINE_OPS_TOKEN;
  if (!base || !token) return { status: "not_configured", drivers: [] };
  if (cache.value && now - cache.at < TTL_MS) return cache.value;
  try {
    const r = await fetchImpl(`${base}/ops/drivers`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
    if (r.status === 401 || r.status === 403) return { status: "token_rejected", drivers: [] };
    if (!r.ok) return { status: "unreachable", drivers: [] };
    const body = await r.json();
    const value = { status: "ok", drivers: (body.drivers || []).map((x) => mapDriver(x, now)) };
    cache = { at: now, value };
    return value;
  } catch {
    return { status: "unreachable", drivers: [] };
  }
}

function resetCache() { cache = { at: 0, value: null }; }

module.exports = { fetchEngineDrivers, mapDriver, resetCache };
