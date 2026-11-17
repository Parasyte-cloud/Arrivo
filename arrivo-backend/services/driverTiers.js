// Which services (tiers) each driver may work.
//
// A driver can hold several tiers. Express and the others are separate: work
// from one tier never reaches a driver who does not hold it. Who may switch a
// tier on is decided in the console, not here (area "driver-tiers" in
// services/staffAccess.js: the owner, plus anyone the owner names).
//
// States per driver and tier:
//   (no row)   off
//   requested  the driver asked in the app, nobody has decided
//   active     on
//   revoked    off, or a request declined (the note says why)
//
// The catalogue and the ride-to-tier mapping are pure so they can be tested
// without a database. `live` says whether this backend has a job pipeline for
// the tier today. Air, Boat, Removals and Campus can be granted already, their
// work arrives in later releases.

const TIERS = Object.freeze([
  { slug: "ride", name: "RideArrivo", tagline: "Airport pickups and drop-offs", accent: "#F4A300", live: true },
  { slug: "express", name: "ArrivoExpress", tagline: "On-demand city rides", accent: "#F5B942", live: true },
  { slug: "chauffeur", name: "ArrivoChauffeur", tagline: "Hire a driver by the day", accent: "#E8D9A8", live: true },
  { slug: "campus", name: "ArrivoCampus", tagline: "Student rides", accent: "#5AA9FF", live: false },
  { slug: "air", name: "ArrivoAir", tagline: "Airport transfers on a plan", accent: "#B69CFF", live: false },
  { slug: "boat", name: "ArrivoBoat", tagline: "Water transport", accent: "#3ED6C4", live: false },
  { slug: "removals", name: "ArrivoRemovals", tagline: "Moves and haulage", accent: "#FF8A5B", live: false },
]);

const TIER_SLUGS = TIERS.map((t) => t.slug);
const cleanTier = (v) => (typeof v === "string" && TIER_SLUGS.includes(v.trim().toLowerCase()) ? v.trim().toLowerCase() : null);

// Rides booked as a charter belong to Chauffeur, every other booking on the
// rides table (arrival pickups and drop-offs) belongs to RideArrivo.
const CHARTER_BOOKING_TYPES = ["full_day", "full_week", "full_month"];
function tierForRide(ride) {
  return CHARTER_BOOKING_TYPES.includes(String(ride?.booking_type || "").toLowerCase()) ? "chauffeur" : "ride";
}

// The same rule as tierForRide, for use inside a query. $-less on purpose:
// the list is fixed, never user input.
const RIDE_TIER_SQL = (alias = "rides") =>
  `(CASE WHEN ${alias}.booking_type IN (${CHARTER_BOOKING_TYPES.map((t) => `'${t}'`).join(", ")}) THEN 'chauffeur' ELSE 'ride' END)`;

// True when the driver holds an active row for the tier, as SQL. $1 is the
// driver id column or parameter the caller passes in.
const HOLDS_TIER_SQL = (driverIdExpr, tierExpr) =>
  `EXISTS (SELECT 1 FROM driver_tier_access dta WHERE dta.driver_id = ${driverIdExpr} AND dta.tier = ${tierExpr} AND dta.status = 'active')`;

class TierError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}

const view = (tier, row) => ({
  ...tier,
  status: row ? row.status : "off",
  decidedAt: row?.decided_at || null,
  requestedAt: row?.requested_at || null,
  note: row?.note || null,
});

function createDriverTiers(pool) {
  async function rowsFor(driverId) {
    const r = await pool.query("SELECT * FROM driver_tier_access WHERE driver_id = $1", [driverId]);
    return new Map(r.rows.map((x) => [x.tier, x]));
  }

  async function listForDriver(driverId) {
    const by = await rowsFor(driverId);
    return TIERS.map((t) => view(t, by.get(t.slug)));
  }

  const activeSlugs = async (driverId) => (await listForDriver(driverId)).filter((t) => t.status === "active").map((t) => t.slug);
  const holds = async (driverId, tier) => {
    const r = await pool.query("SELECT 1 FROM driver_tier_access WHERE driver_id = $1 AND tier = $2 AND status = 'active'", [driverId, tier]);
    return r.rowCount > 0;
  };

  async function mustFindDriver(client, driverId) {
    const d = (await client.query("SELECT d.id, u.name FROM drivers d JOIN users u ON u.id = d.user_id WHERE d.id = $1", [driverId])).rows[0];
    if (!d) throw new TierError(404, "Driver not found", "driver_not_found");
    return d;
  }

  async function write({ driverId, tier, status, actorId, note, event }) {
    const t = cleanTier(tier);
    if (!t) throw new TierError(400, `tier must be one of: ${TIER_SLUGS.join(", ")}`, "tier_invalid");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await mustFindDriver(client, driverId);
      const cur = (await client.query("SELECT status FROM driver_tier_access WHERE driver_id = $1 AND tier = $2 FOR UPDATE", [driverId, t])).rows[0];
      await client.query(
        `INSERT INTO driver_tier_access (driver_id, tier, status, decided_by, decided_at, note, requested_at, updated_at)
         VALUES ($1, $2, $3, $4, now(), $5, CASE WHEN $3 = 'requested' THEN now() END, now())
         ON CONFLICT (driver_id, tier) DO UPDATE
           SET status = EXCLUDED.status, decided_by = EXCLUDED.decided_by, decided_at = EXCLUDED.decided_at,
               note = EXCLUDED.note, updated_at = now()`,
        [driverId, t, status, actorId || null, note || null]
      );
      await client.query(
        "INSERT INTO driver_tier_events (driver_id, tier, action, actor_id, note) VALUES ($1, $2, $3, $4, $5)",
        [driverId, t, event, actorId || null, note || null]
      );
      await client.query("COMMIT");
      return { tier: t, previous: cur?.status || "off", status };
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally { client.release(); }
  }

  const grant = ({ driverId, tier, actorId, note }) =>
    write({ driverId, tier, status: "active", actorId, note: String(note || "").trim().slice(0, 240) || null, event: "granted" });

  function revoke({ driverId, tier, actorId, note }) {
    const reason = String(note || "").trim().slice(0, 240);
    if (reason.length < 3) throw new TierError(400, "Say why. A short reason is needed to switch a service off.", "tier_reason_required");
    return write({ driverId, tier, status: "revoked", actorId, note: reason, event: "revoked" });
  }

  // A driver asking for a tier. Never switches anything on. A tier that is
  // already on or already waiting is left exactly as it is.
  async function request({ driverId, tier }) {
    const t = cleanTier(tier);
    if (!t) throw new TierError(400, `tier must be one of: ${TIER_SLUGS.join(", ")}`, "tier_invalid");
    const cur = (await pool.query("SELECT status FROM driver_tier_access WHERE driver_id = $1 AND tier = $2", [driverId, t])).rows[0];
    if (cur && (cur.status === "active" || cur.status === "requested")) return { tier: t, status: cur.status, changed: false };
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO driver_tier_access (driver_id, tier, status, requested_at, updated_at) VALUES ($1, $2, 'requested', now(), now())
         ON CONFLICT (driver_id, tier) DO UPDATE SET status = 'requested', requested_at = now(), updated_at = now(), note = NULL
           WHERE driver_tier_access.status = 'revoked'`,
        [driverId, t]
      );
      await client.query("INSERT INTO driver_tier_events (driver_id, tier, action, actor_id) VALUES ($1, $2, 'requested', NULL)", [driverId, t]);
      await client.query("COMMIT");
    } catch (e) { await client.query("ROLLBACK").catch(() => {}); throw e; } finally { client.release(); }
    return { tier: t, status: "requested", changed: true };
  }

  // The console list: drivers with their seven tiers each. Drivers waiting on
  // a request come first so they are not buried.
  async function overview({ q, limit = 200 } = {}) {
    const term = String(q || "").trim().slice(0, 60);
    const params = [];
    let where = "d.archived_at IS NULL";
    if (term) {
      params.push(`%${term}%`, term.replace(/\D/g, "") || "-1");
      where += " AND (u.name ILIKE $1 OR u.email ILIKE $1 OR v.plate_number ILIKE $1 OR d.id::text = $2)";
    }
    params.push(Math.min(Math.max(Number(limit) || 200, 1), 500));
    const rows = (await pool.query(
      `SELECT d.id, u.name, d.is_verified, d.is_online, v.plate_number,
              (SELECT count(*) FROM driver_tier_access a WHERE a.driver_id = d.id AND a.status = 'requested') AS waiting
         FROM drivers d
         JOIN users u ON u.id = d.user_id
         LEFT JOIN vehicles v ON v.id = d.vehicle_id
        WHERE ${where}
        ORDER BY waiting DESC, d.created_at DESC
        LIMIT $${params.length}`,
      params
    )).rows;
    if (!rows.length) return { catalogue: TIERS, drivers: [] };
    const acc = (await pool.query("SELECT * FROM driver_tier_access WHERE driver_id = ANY($1::int[])", [rows.map((r) => r.id)])).rows;
    const by = new Map();
    for (const a of acc) { if (!by.has(a.driver_id)) by.set(a.driver_id, new Map()); by.get(a.driver_id).set(a.tier, a); }
    return {
      catalogue: TIERS,
      drivers: rows.map((r) => ({
        id: r.id, name: r.name, verified: !!r.is_verified, online: !!r.is_online, plate: r.plate_number || null,
        waiting: Number(r.waiting),
        tiers: TIERS.map((t) => view(t, by.get(r.id)?.get(t.slug))),
      })),
    };
  }

  async function events(driverId, limit = 50) {
    return (await pool.query(
      `SELECT e.id, e.tier, e.action, e.note, e.created_at, u.name AS actor_name
         FROM driver_tier_events e LEFT JOIN users u ON u.id = e.actor_id
        WHERE e.driver_id = $1 ORDER BY e.created_at DESC, e.id DESC LIMIT $2`,
      [driverId, Math.min(Number(limit) || 50, 200)]
    )).rows;
  }

  return { listForDriver, activeSlugs, holds, grant, revoke, request, overview, events };
}

module.exports = { TIERS, TIER_SLUGS, cleanTier, tierForRide, RIDE_TIER_SQL, HOLDS_TIER_SQL, TierError, createDriverTiers };
