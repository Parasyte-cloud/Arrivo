// Rider welfare check, for every service that runs a trip (RideArrivo,
// ArrivoExpress, ArrivoChauffeur).
//
// While a trip is in progress the rider's phone sends its position every
// ~30 seconds. If the rider has stayed within 50 m of one spot for 5 minutes
// we ask "Are you safe?". "Yes" resets the clock and doubles the next wait
// (up to 4x). "No", or no answer within 2 minutes, raises a safety alert that
// pages the on-call team through the same path as the panic button.
//
// The rules live in decide() and answerState(), which are pure so they can be
// tested without a database. The DB layer below only loads, saves and raises.
//
// Deliberate pauses, so we never nag someone who is fine:
//   * the first 3 minutes of the trip
//   * within 200 m of the destination (when we know it)
//   * a GPS fix worse than 100 m
//   * after a gap of over 2 minutes with no ping (phone asleep or no signal),
//     the clock restarts instead of counting the gap as "stationary"
const { logSafetyEvent } = require("./safetyEvents");

const RULES = Object.freeze({
  STILL_RADIUS_M: 50,
  STILL_MINUTES: 5,
  ANSWER_SECONDS: 120,
  TRIP_GRACE_MINUTES: 3,
  DESTINATION_RADIUS_M: 200,
  MAX_ACCURACY_M: 100,
  SILENT_GAP_SECONDS: 120,
  MAX_MULTIPLIER: 4,
});

class WelfareError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}

function metres(a, b) {
  const R = 6371000, rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// The wait before asking: 5 minutes times the multiplier (1 to 4), in ms.
const waitMs = (state) => RULES.STILL_MINUTES * 60000 * Math.max(1, Math.min(RULES.MAX_MULTIPLIER, state.multiplier || 1));

const validPoint = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

// state: null | { anchor:{lat,lng}, anchorAt:ms, lastPingAt:ms, multiplier, askedAt:ms|null, status }
// ping: { lat, lng, accuracy }   ctx: { now:ms, tripStartedAt:ms|null, destination:{lat,lng}|null }
// returns { state, action: "none" | "ask" | "raise", reason }
function decide(state, ping, ctx) {
  const now = ctx.now;
  if (!validPoint(ping.lat, ping.lng)) return { state, action: "none", reason: "bad_position" };
  if (state && state.status === "raised") return { state, action: "none", reason: "already_raised" };

  // A question that went unanswered for too long raises, whatever else is true.
  if (state && state.askedAt && now - state.askedAt >= RULES.ANSWER_SECONDS * 1000) {
    return { state: { ...state, status: "raised" }, action: "raise", reason: "no_answer" };
  }

  if (typeof ping.accuracy === "number" && ping.accuracy > RULES.MAX_ACCURACY_M) {
    return { state, action: "none", reason: "low_accuracy" };
  }

  const here = { lat: ping.lat, lng: ping.lng };
  const fresh = { anchor: here, anchorAt: now, lastPingAt: now, multiplier: state?.multiplier || 1, askedAt: null, status: "ok" };
  if (!state) return { state: fresh, action: "none", reason: "first_ping" };

  if (now - state.lastPingAt > RULES.SILENT_GAP_SECONDS * 1000) return { state: fresh, action: "none", reason: "silent_gap" };
  if (metres(state.anchor, here) > RULES.STILL_RADIUS_M) return { state: { ...fresh, multiplier: state.multiplier }, action: "none", reason: "moving" };

  const next = { ...state, lastPingAt: now };
  if (ctx.tripStartedAt && now - ctx.tripStartedAt < RULES.TRIP_GRACE_MINUTES * 60000) {
    return { state: { ...next, anchorAt: now }, action: "none", reason: "trip_just_started" };
  }
  if (ctx.destination && validPoint(ctx.destination.lat, ctx.destination.lng) && metres(ctx.destination, here) <= RULES.DESTINATION_RADIUS_M) {
    return { state: { ...next, anchorAt: now, askedAt: null, status: "ok" }, action: "none", reason: "near_destination" };
  }
  if (!state.askedAt && now - state.anchorAt >= waitMs(state)) {
    return { state: { ...next, askedAt: now, status: "asking" }, action: "ask", reason: "stationary" };
  }
  return { state: next, action: "none", reason: "waiting" };
}

// The rider's answer to "Are you safe?".
function answerState(state, safe, now) {
  if (!state) return { state, action: "none", reason: "nothing_to_answer" };
  if (state.status === "raised") return { state, action: "none", reason: "already_raised" };
  if (!state.askedAt) return { state, action: "none", reason: "not_asked" };
  if (!safe) return { state: { ...state, status: "raised" }, action: "raise", reason: "rider_not_safe" };
  return {
    state: { ...state, anchorAt: now, askedAt: null, status: "ok", multiplier: Math.min(RULES.MAX_MULTIPLIER, (state.multiplier || 1) * 2) },
    action: "none", reason: "rider_safe",
  };
}

// ── database layer ──
const toState = (r) => r && ({
  anchor: { lat: r.anchor_lat, lng: r.anchor_lng },
  anchorAt: new Date(r.anchor_at).getTime(),
  lastPingAt: new Date(r.last_ping_at).getTime(),
  multiplier: r.multiplier,
  askedAt: r.asked_at ? new Date(r.asked_at).getTime() : null,
  status: r.status,
});

function createWelfareCheck(pool, { onRaise } = {}) {
  async function loadRide(client, rideId, userId) {
    const r = (await client.query(
      `SELECT rides.id, rides.rider_id, rides.ride_status, rides.tracking_started_at, rides.panic_triggered_at,
              irr.destination_lat, irr.destination_lng
         FROM rides LEFT JOIN instant_ride_requests irr ON irr.ride_id = rides.id
        WHERE rides.id = $1`, [rideId])).rows[0];
    if (!r || r.rider_id !== userId) throw new WelfareError(404, "Ride not found", "ride_not_found");
    return r;
  }

  async function save(client, rideId, s, raisedReason) {
    await client.query(
      `INSERT INTO ride_welfare (ride_id, anchor_lat, anchor_lng, anchor_at, last_ping_at, multiplier, asked_at, status, raised_at, raised_reason)
       VALUES ($1,$2,$3,to_timestamp($4/1000.0),to_timestamp($5/1000.0),$6,CASE WHEN $7::bigint IS NULL THEN NULL ELSE to_timestamp($7/1000.0) END,$8,
               CASE WHEN $8 = 'raised' THEN now() END, $9)
       ON CONFLICT (ride_id) DO UPDATE SET anchor_lat = EXCLUDED.anchor_lat, anchor_lng = EXCLUDED.anchor_lng, anchor_at = EXCLUDED.anchor_at,
         last_ping_at = EXCLUDED.last_ping_at, multiplier = EXCLUDED.multiplier, asked_at = EXCLUDED.asked_at, status = EXCLUDED.status,
         raised_at = COALESCE(ride_welfare.raised_at, EXCLUDED.raised_at), raised_reason = COALESCE(ride_welfare.raised_reason, EXCLUDED.raised_reason)`,
      [rideId, s.anchor.lat, s.anchor.lng, s.anchorAt, s.lastPingAt, s.multiplier, s.askedAt, s.status, raisedReason || null]
    );
  }

  async function raise(client, ride, userId, reason, state) {
    // Same record the panic button writes, so it lands in the Panic Alerts
    // page and pages the on-call team. The listening device is NOT switched
    // on: that is a decision for the person who presses panic.
    await client.query(
      `UPDATE rides SET panic_triggered_at = COALESCE(panic_triggered_at, now()),
              panic_notes = COALESCE(panic_notes, $2), updated_at = now() WHERE id = $1`,
      [ride.id, `Welfare check: ${reason === "no_answer" ? "rider did not answer 'Are you safe?'" : "rider said they are not safe"}. Last position ${state.anchor.lat.toFixed(5)}, ${state.anchor.lng.toFixed(5)}.`]
    );
    await logSafetyEvent(client, "welfare_raised", { rideId: ride.id, userId, detail: { reason, lat: state.anchor.lat, lng: state.anchor.lng } });
  }

  async function run(rideId, userId, step) {
    const client = await pool.connect();
    let raised = null;
    try {
      await client.query("BEGIN");
      const ride = await loadRide(client, rideId, userId);
      if (ride.ride_status !== "in_progress") { await client.query("COMMIT"); return { watching: false, ask: false }; }
      const cur = toState((await client.query("SELECT * FROM ride_welfare WHERE ride_id = $1 FOR UPDATE", [rideId])).rows[0]);
      const out = step(cur, ride);
      if (out.state) await save(client, rideId, out.state, out.action === "raise" ? out.reason : null);
      if (out.action === "raise" && cur?.status !== "raised") { await raise(client, ride, userId, out.reason, out.state); raised = out.reason; }
      await client.query("COMMIT");
      if (raised && onRaise) onRaise(rideId, userId);
      const asking = out.state?.status === "asking";
      return {
        watching: true, ask: asking, raised: out.state?.status === "raised",
        answerWithinSeconds: asking ? Math.max(0, Math.round(RULES.ANSWER_SECONDS - (Date.now() - out.state.askedAt) / 1000)) : null,
      };
    } catch (e) { await client.query("ROLLBACK").catch(() => {}); throw e; } finally { client.release(); }
  }

  const ping = ({ rideId, userId, lat, lng, accuracy }) =>
    run(rideId, userId, (cur, ride) => decide(cur, { lat: Number(lat), lng: Number(lng), accuracy: accuracy == null ? undefined : Number(accuracy) }, {
      now: Date.now(),
      tripStartedAt: ride.tracking_started_at ? new Date(ride.tracking_started_at).getTime() : null,
      destination: ride.destination_lat != null ? { lat: ride.destination_lat, lng: ride.destination_lng } : null,
    }));

  // Questions nobody answered. The app may be closed or the phone dead, so no
  // further ping will ever arrive to trigger the raise: a timer calls this.
  async function sweepOverdue() {
    const due = (await pool.query(
      `SELECT w.ride_id, r.rider_id FROM ride_welfare w JOIN rides r ON r.id = w.ride_id
        WHERE w.status = 'asking' AND w.asked_at < now() - ($1 || ' seconds')::interval AND r.ride_status = 'in_progress'
        LIMIT 50`, [String(RULES.ANSWER_SECONDS)])).rows;
    let raised = 0;
    for (const d of due) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const row = (await client.query("SELECT * FROM ride_welfare WHERE ride_id = $1 AND status = 'asking' FOR UPDATE", [d.ride_id])).rows[0];
        if (!row) { await client.query("COMMIT"); continue; }
        const state = { ...toState(row), status: "raised" };
        await save(client, d.ride_id, state, "no_answer");
        await raise(client, { id: d.ride_id }, d.rider_id, "no_answer", state);
        await client.query("COMMIT");
        raised++;
        if (onRaise) onRaise(d.ride_id, d.rider_id);
      } catch (e) { await client.query("ROLLBACK").catch(() => {}); console.error("[welfare] sweep failed for ride", d.ride_id, e.message); }
      finally { client.release(); }
    }
    return raised;
  }

  const answer = ({ rideId, userId, safe }) => run(rideId, userId, (cur) => answerState(cur, !!safe, Date.now()));

  return { ping, answer, sweepOverdue };
}

module.exports = { RULES, WelfareError, metres, decide, answerState, createWelfareCheck };
