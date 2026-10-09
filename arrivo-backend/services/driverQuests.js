// Driver quests for ArrivoExpress: "complete N qualifying trips in the window
// and earn a fixed amount."
//
// Why quests and not blanket bonuses. Across-the-board boosts ("+20% on every
// trip this week") teach drivers to wait for the next boost, then log off when
// it ends. They also cost whatever volume happens to be, with no ceiling. A
// quest pays for a specific behaviour (finishing real trips, reliably) and
// has a fixed worst-case cost, so incentives can be offered from day one
// without the budget running away.
//
// How it stays honest.
//   * Cost ceiling: every quest has max_winners, so the most it can ever cost
//     is reward_naira * max_winners, and creating one above the budget cap is
//     refused (QUEST_MAX_BUDGET_NAIRA, default 2,000,000).
//   * Real trips only: the ride must be a completed ArrivoExpress ride with a
//     started trip, a minimum distance and a minimum duration, so a tap-in
//     tap-out "trip" does not count.
//   * No collusion: at most max_trips_per_rider trips per rider count toward
//     one driver's quest, so a driver and a friend cannot ping-pong.
//   * Counted once: UNIQUE(quest_id, ride_id) means a retry or a double
//     completion cannot count a ride twice, and UNIQUE(quest_id, driver_id) on
//     payouts means a quest is earned once per driver.
//   * Money does not move here. Completing a quest creates an 'owed' record;
//     an admin marks it paid after the normal payout. Nothing in this file
//     touches a wallet.

const { listTiers } = require("./instantTiers");

class QuestError extends Error {
  constructor(message, status = 400, code = "INVALID_QUEST") {
    super(message);
    this.name = "QuestError";
    this.status = status;
    this.code = code;
  }
}

function maxBudgetNaira() {
  const v = Number(process.env.QUEST_MAX_BUDGET_NAIRA);
  return Number.isFinite(v) && v > 0 ? v : 2000000;
}

function whole(value, name, min, max, fallback) {
  if (value === undefined || value === null || value === "") {
    if (fallback !== undefined) return fallback;
    throw new QuestError(`${name} is required`);
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new QuestError(`${name} must be a whole number from ${min} to ${max}`);
  }
  return n;
}

function decimal(value, name, min, max, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new QuestError(`${name} must be from ${min} to ${max}`);
  }
  return n;
}

// Pure. Cleans a new quest.
function validateQuest(input = {}, now = new Date()) {
  const title = String(input.title || "").trim();
  if (title.length < 3 || title.length > 80) throw new QuestError("title must be 3 to 80 characters");

  let tier = null;
  if (input.tier !== undefined && input.tier !== null && input.tier !== "") {
    tier = String(input.tier).toLowerCase();
    if (!listTiers().some((t) => t.key === tier)) {
      throw new QuestError(`tier must be one of: ${listTiers().map((t) => t.key).join(", ")} (or leave it out for any tier)`);
    }
  }

  const targetTrips = whole(input.targetTrips, "targetTrips", 1, 200);
  const rewardNaira = whole(input.rewardNaira, "rewardNaira", 100, 500000);
  const maxWinners = whole(input.maxWinners, "maxWinners", 1, 100000);

  const budget = rewardNaira * maxWinners;
  if (budget > maxBudgetNaira()) {
    throw new QuestError(
      `This quest could cost up to NGN ${budget.toLocaleString()} (reward x max winners), above the NGN ${maxBudgetNaira().toLocaleString()} limit. Lower the reward or the number of winners.`,
      409,
      "QUEST_BUDGET_TOO_LARGE"
    );
  }

  const startsAt = new Date(input.startsAt || now);
  const endsAt = new Date(input.endsAt);
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) {
    throw new QuestError("startsAt and endsAt must be valid dates and times");
  }
  if (endsAt <= startsAt) throw new QuestError("endsAt must be after startsAt");
  if (endsAt.getTime() - startsAt.getTime() > 31 * 24 * 60 * 60 * 1000) {
    throw new QuestError("A quest can run for at most 31 days");
  }
  if (endsAt.getTime() <= now.getTime()) throw new QuestError("endsAt is already in the past");

  return {
    title,
    tier,
    targetTrips,
    rewardNaira,
    maxWinners,
    minTripKm: decimal(input.minTripKm, "minTripKm", 0.5, 20, 1),
    minTripMinutes: whole(input.minTripMinutes, "minTripMinutes", 1, 60, 3),
    maxTripsPerRider: whole(input.maxTripsPerRider, "maxTripsPerRider", 1, 10, 2),
    minDriverRating: decimal(input.minDriverRating, "minDriverRating", 1, 5, null),
    startsAt,
    endsAt,
    maxLiabilityNaira: budget,
  };
}

// Pure. Does this finished ride count toward this quest? Returns
// { counts, reason }. `riderTripsAlready` is how many trips with this same
// rider already counted toward this driver's quest.
function evaluateTrip(quest, trip, { riderTripsAlready = 0 } = {}) {
  if (trip.rideStatus !== "completed" || !trip.completedAt) return { counts: false, reason: "not_completed" };
  const completed = new Date(trip.completedAt).getTime();
  if (completed < new Date(quest.starts_at).getTime() || completed > new Date(quest.ends_at).getTime()) {
    return { counts: false, reason: "outside_window" };
  }
  if (quest.tier && trip.tier !== quest.tier) return { counts: false, reason: "tier_mismatch" };
  if (!trip.trackingStartedAt) return { counts: false, reason: "trip_never_started" };
  const minutes = (completed - new Date(trip.trackingStartedAt).getTime()) / 60000;
  if (!(minutes >= Number(quest.min_trip_minutes))) return { counts: false, reason: "too_short_in_time" };
  if (!(Number(trip.distanceKm) >= Number(quest.min_trip_km))) return { counts: false, reason: "too_short_in_distance" };
  if (riderTripsAlready >= Number(quest.max_trips_per_rider)) return { counts: false, reason: "rider_limit_reached" };
  if (quest.min_driver_rating != null && !(Number(trip.driverRating) >= Number(quest.min_driver_rating))) {
    return { counts: false, reason: "rating_too_low" };
  }
  return { counts: true, reason: "ok" };
}

function getPool() {
  return require("../db/db").pool;
}

// Called after a ride is marked completed. Safe to call for any ride and any
// number of times: a ride that is not an ArrivoExpress ride, or that already
// counted, changes nothing. Never throws to the caller's flow when wrapped as
// documented in routes/rides.js.
async function recordQuestProgress(rideId, db) {
  const pool = db || getPool();
  const rideResult = await pool.query(
    `SELECT r.id, r.driver_id, r.rider_id, r.ride_status, r.completed_at, r.tracking_started_at,
            irr.tier, irr.estimated_distance_km, d.rating AS driver_rating
       FROM rides r
       JOIN instant_ride_requests irr ON irr.ride_id = r.id
       JOIN drivers d ON d.id = r.driver_id
      WHERE r.id = $1`,
    [rideId]
  );
  const row = rideResult.rows[0];
  if (!row) return [];

  const trip = {
    rideStatus: row.ride_status,
    completedAt: row.completed_at,
    trackingStartedAt: row.tracking_started_at,
    distanceKm: row.estimated_distance_km,
    tier: row.tier,
    driverRating: row.driver_rating,
  };

  const quests = await pool.query(
    `SELECT * FROM driver_quests
      WHERE is_active = true
        AND starts_at <= $1 AND ends_at >= $1
        AND (tier IS NULL OR tier = $2)`,
    [row.completed_at, row.tier]
  );

  const outcomes = [];
  for (const quest of quests.rows) {
    const client = pool.connect ? await pool.connect() : pool;
    try {
      await client.query("BEGIN");
      // One quest at a time: serialises the "is there still a winner slot?"
      // check so two drivers finishing together cannot both take the last one.
      await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [quest.id]);

      const alreadyEarned = await client.query(
        "SELECT 1 FROM driver_quest_payouts WHERE quest_id = $1 AND driver_id = $2",
        [quest.id, row.driver_id]
      );
      if (alreadyEarned.rowCount) {
        await client.query("COMMIT");
        outcomes.push({ questId: quest.id, counted: false, reason: "already_earned" });
        continue;
      }

      const sameRider = await client.query(
        "SELECT count(*)::int AS n FROM driver_quest_trips WHERE quest_id = $1 AND driver_id = $2 AND rider_id = $3",
        [quest.id, row.driver_id, row.rider_id]
      );
      const verdict = evaluateTrip(quest, trip, { riderTripsAlready: sameRider.rows[0].n });
      if (!verdict.counts) {
        await client.query("COMMIT");
        outcomes.push({ questId: quest.id, counted: false, reason: verdict.reason });
        continue;
      }

      const inserted = await client.query(
        `INSERT INTO driver_quest_trips (quest_id, driver_id, ride_id, rider_id)
         VALUES ($1, $2, $3, $4) ON CONFLICT (quest_id, ride_id) DO NOTHING RETURNING id`,
        [quest.id, row.driver_id, row.id, row.rider_id]
      );
      if (!inserted.rowCount) {
        await client.query("COMMIT");
        outcomes.push({ questId: quest.id, counted: false, reason: "already_counted" });
        continue;
      }

      const progress = await client.query(
        "SELECT count(*)::int AS n FROM driver_quest_trips WHERE quest_id = $1 AND driver_id = $2",
        [quest.id, row.driver_id]
      );
      let earned = false;
      let quotaFull = false;
      if (progress.rows[0].n >= quest.target_trips) {
        const winners = await client.query("SELECT count(*)::int AS n FROM driver_quest_payouts WHERE quest_id = $1", [quest.id]);
        if (winners.rows[0].n >= quest.max_winners) {
          quotaFull = true;
        } else {
          await client.query(
            `INSERT INTO driver_quest_payouts (quest_id, driver_id, reward_naira)
             VALUES ($1, $2, $3) ON CONFLICT (quest_id, driver_id) DO NOTHING`,
            [quest.id, row.driver_id, quest.reward_naira]
          );
          earned = true;
        }
      }
      await client.query("COMMIT");
      outcomes.push({ questId: quest.id, counted: true, progress: progress.rows[0].n, target: quest.target_trips, earned, quotaFull });
      // Settle straight away when automatic payout is on. Outside the counting
      // transaction and never allowed to fail it: if this does not run, the
      // reward simply stays 'owed' and the next sweep (or an admin) pays it.
      if (earned) {
        try {
          await require("./questPayout").autoPayOwed({ db: pool });
        } catch (error) {
          console.error(`Auto payout after quest #${quest.id} failed (stays owed):`, error.message);
        }
      }
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      if (client.release) client.release();
    }
  }
  return outcomes;
}

// What a driver sees: quests running now (or ended in the last 7 days, so a
// just-earned reward is still visible), their progress, and whether it is paid.
async function listDriverQuests(driverId, db) {
  const result = await (db || getPool()).query(
    `SELECT q.id, q.title, q.tier, q.target_trips AS "targetTrips", q.reward_naira AS "rewardNaira",
            q.min_trip_km AS "minTripKm", q.min_trip_minutes AS "minTripMinutes",
            q.max_trips_per_rider AS "maxTripsPerRider", q.min_driver_rating AS "minDriverRating",
            q.starts_at AS "startsAt", q.ends_at AS "endsAt",
            (SELECT count(*)::int FROM driver_quest_trips t WHERE t.quest_id = q.id AND t.driver_id = $1) AS progress,
            p.status AS "payoutStatus",
            (SELECT count(*)::int FROM driver_quest_payouts w WHERE w.quest_id = q.id) >= q.max_winners AS "quotaFull"
       FROM driver_quests q
       LEFT JOIN driver_quest_payouts p ON p.quest_id = q.id AND p.driver_id = $1
      WHERE q.is_active = true
        AND q.starts_at <= now() + interval '1 day'
        AND q.ends_at >= now() - interval '7 days'
      ORDER BY q.ends_at ASC`,
    [driverId]
  );
  return result.rows.map((q) => ({
    ...q,
    earned: Boolean(q.payoutStatus),
    paid: q.payoutStatus === "paid",
    active: new Date(q.startsAt) <= new Date() && new Date(q.endsAt) >= new Date(),
  }));
}

async function createQuest(input, userId, db) {
  const q = validateQuest(input);
  const result = await (db || getPool()).query(
    `INSERT INTO driver_quests
       (title, tier, target_trips, reward_naira, max_winners, min_trip_km, min_trip_minutes,
        max_trips_per_rider, min_driver_rating, starts_at, ends_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id`,
    [q.title, q.tier, q.targetTrips, q.rewardNaira, q.maxWinners, q.minTripKm, q.minTripMinutes,
     q.maxTripsPerRider, q.minDriverRating, q.startsAt, q.endsAt, userId || null]
  );
  return { id: result.rows[0].id, maxLiabilityNaira: q.maxLiabilityNaira };
}

async function listQuestsForAdmin(db) {
  const result = await (db || getPool()).query(
    `SELECT q.id, q.title, q.tier, q.target_trips AS "targetTrips", q.reward_naira AS "rewardNaira",
            q.max_winners AS "maxWinners", q.starts_at AS "startsAt", q.ends_at AS "endsAt", q.is_active AS "isActive",
            q.reward_naira::bigint * q.max_winners AS "maxLiabilityNaira",
            (SELECT count(*)::int FROM driver_quest_payouts p WHERE p.quest_id = q.id) AS winners,
            (SELECT coalesce(sum(p.reward_naira), 0)::bigint FROM driver_quest_payouts p WHERE p.quest_id = q.id AND p.status = 'owed') AS "owedNaira",
            (SELECT coalesce(sum(p.reward_naira), 0)::bigint FROM driver_quest_payouts p WHERE p.quest_id = q.id AND p.status = 'paid') AS "paidNaira",
            (SELECT count(DISTINCT t.driver_id)::int FROM driver_quest_trips t WHERE t.quest_id = q.id) AS "driversParticipating"
       FROM driver_quests q
      ORDER BY q.created_at DESC
      LIMIT 100`
  );
  return result.rows;
}

// Stops a quest from counting new trips. Progress and any reward already
// earned are kept: ending a quest early must never take away what a driver
// has already earned.
async function endQuest(questId, db) {
  const result = await (db || getPool()).query(
    "UPDATE driver_quests SET is_active = false WHERE id = $1 RETURNING id",
    [questId]
  );
  if (!result.rowCount) throw new QuestError("Quest not found", 404, "NOT_FOUND");
  return { id: result.rows[0].id, isActive: false };
}

async function listPayouts({ status, db } = {}) {
  const result = await (db || getPool()).query(
    `SELECT p.id, p.quest_id AS "questId", q.title, p.driver_id AS "driverId", u.name AS "driverName",
            u.phone AS "driverPhone", p.reward_naira AS "rewardNaira", p.status,
            p.earned_at AS "earnedAt", p.paid_at AS "paidAt", p.paid_via AS "paidVia"
       FROM driver_quest_payouts p
       JOIN driver_quests q ON q.id = p.quest_id
       JOIN drivers d ON d.id = p.driver_id
       JOIN users u ON u.id = d.user_id
      WHERE ($1::text IS NULL OR p.status = $1)
      ORDER BY p.earned_at ASC
      LIMIT 500`,
    [status || null]
  );
  return result.rows;
}

// Idempotent: marking an already-paid payout again is a no-op, not an error,
// so a double click or a retry cannot create confusion.
async function markPayoutPaid(payoutId, adminId, db) {
  const result = await (db || getPool()).query(
    `UPDATE driver_quest_payouts
        SET status = 'paid', paid_at = COALESCE(paid_at, now()), paid_by = COALESCE(paid_by, $2),
            paid_via = COALESCE(paid_via, 'manual')
      WHERE id = $1
      RETURNING id, status, paid_at AS "paidAt"`,
    [payoutId, adminId || null]
  );
  if (!result.rowCount) throw new QuestError("Payout not found", 404, "NOT_FOUND");
  return result.rows[0];
}

module.exports = {
  QuestError,
  validateQuest,
  evaluateTrip,
  recordQuestProgress,
  listDriverQuests,
  createQuest,
  listQuestsForAdmin,
  endQuest,
  listPayouts,
  markPayoutPaid,
};
