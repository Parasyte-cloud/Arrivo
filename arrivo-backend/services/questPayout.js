// Paying earned driver quests into the driver's RideArrivo wallet.
//
// The rule that matters most here: a reward is credited AT MOST ONCE, no
// matter how many times, from how many places, at the same moment, this is
// asked to pay it. The payout row is locked (SELECT ... FOR UPDATE) for the
// whole credit, and the status check happens under that lock, so two
// concurrent attempts serialise: the first credits, the second finds it
// already paid and does nothing. The wallet ledger row id is stored on the
// payout, so every credited naira traces to one payout and back.
//
// Automatic payment is OFF until an admin turns it on
// (express_auto_payout_enabled), and when on it has a daily ceiling
// (QUEST_AUTO_PAYOUT_DAILY_CAP_NAIRA, default 500,000). Past the ceiling
// payouts simply stay 'owed' for a human to review, which also bounds the
// damage if a quest were ever misconfigured or gamed. An admin paying one or
// all owed rewards by hand is an explicit act and is not subject to the cap.

const { getConfigBool } = require("./systemConfig");

class PayoutError extends Error {
  constructor(message, status = 400, code = "PAYOUT_ERROR") {
    super(message);
    this.name = "PayoutError";
    this.status = status;
    this.code = code;
  }
}

function dailyCapNaira() {
  const v = Number(process.env.QUEST_AUTO_PAYOUT_DAILY_CAP_NAIRA);
  return Number.isFinite(v) && v > 0 ? v : 500000;
}

function getPool() {
  return require("../db/db").pool;
}

async function logEvent(db, action, detail) {
  await db.query(
    "INSERT INTO express_automation_log (kind, action, detail) VALUES ('payout', $1, $2::jsonb)",
    [action, JSON.stringify(detail || {})]
  );
}

// Credits one payout to the driver's wallet. Safe to call repeatedly.
//   actor: { adminId } for a person, {} for the automatic path
async function payToWallet(payoutId, { adminId = null, db } = {}) {
  const pool = db || getPool();
  const client = pool.connect ? await pool.connect() : pool;
  try {
    await client.query("BEGIN");
    const found = await client.query(
      `SELECT p.id, p.status, p.reward_naira, p.driver_id, p.quest_id, d.user_id, q.title
         FROM driver_quest_payouts p
         JOIN drivers d ON d.id = p.driver_id
         JOIN driver_quests q ON q.id = p.quest_id
        WHERE p.id = $1
          FOR UPDATE OF p`,
      [payoutId]
    );
    const p = found.rows[0];
    if (!p) {
      await client.query("ROLLBACK");
      throw new PayoutError("Payout not found", 404, "NOT_FOUND");
    }
    if (p.status === "paid") {
      await client.query("COMMIT");
      return { payoutId: p.id, credited: false, alreadyPaid: true };
    }

    const reward = Number(p.reward_naira);
    const bal = await client.query(
      "UPDATE users SET wallet_balance_naira = wallet_balance_naira + $1 WHERE id = $2 RETURNING wallet_balance_naira",
      [reward, p.user_id]
    );
    const balance = Number(bal.rows[0].wallet_balance_naira);
    const tx = await client.query(
      `INSERT INTO wallet_transactions (user_id, type, status, amount_naira, balance_after_naira, description)
       VALUES ($1, 'credit', 'completed', $2, $3, $4) RETURNING id`,
      [p.user_id, reward, balance, `ArrivoExpress quest reward: ${p.title}`]
    );
    await client.query(
      `UPDATE driver_quest_payouts
          SET status = 'paid', paid_at = now(), paid_by = $2, paid_via = 'wallet', wallet_transaction_id = $3
        WHERE id = $1`,
      [p.id, adminId, tx.rows[0].id]
    );
    await logEvent(client, "paid", {
      payoutId: p.id, questId: p.quest_id, driverId: p.driver_id, rewardNaira: reward,
      by: adminId ? { adminId } : "automatic", walletTransactionId: tx.rows[0].id,
    });
    await client.query("COMMIT");
    return { payoutId: p.id, credited: true, rewardNaira: reward, balanceNaira: balance, walletTransactionId: tx.rows[0].id };
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch (_) { /* already rolled back */ }
    throw error;
  } finally {
    if (client.release) client.release();
  }
}

// How much the automatic path has already paid today (Lagos time).
async function autoPaidTodayNaira(db) {
  const r = await (db || getPool()).query(
    `SELECT coalesce(sum(reward_naira), 0)::bigint AS total
       FROM driver_quest_payouts
      WHERE paid_via = 'wallet' AND paid_by IS NULL
        AND (paid_at AT TIME ZONE 'Africa/Lagos')::date = (now() AT TIME ZONE 'Africa/Lagos')::date`
  );
  return Number(r.rows[0].total);
}

// Automatic payment of everything owed, oldest first, until the daily ceiling.
// Returns what it did. A no-op while the switch is off.
async function autoPayOwed({ db } = {}) {
  const pool = db || getPool();
  if (!(await getConfigBool("express_auto_payout_enabled", false))) {
    return { enabled: false, paid: 0, skipped: 0 };
  }
  const cap = dailyCapNaira();
  let spent = await autoPaidTodayNaira(pool);
  const owed = await pool.query(
    "SELECT id, reward_naira FROM driver_quest_payouts WHERE status = 'owed' ORDER BY earned_at ASC, id ASC LIMIT 200"
  );
  let paid = 0;
  let paidNaira = 0;
  let held = 0;
  for (const row of owed.rows) {
    const reward = Number(row.reward_naira);
    if (spent + reward > cap) {
      held += 1;
      continue;
    }
    const result = await payToWallet(row.id, { db: pool });
    if (result.credited) {
      paid += 1;
      paidNaira += reward;
      spent += reward;
    }
  }
  if (held > 0) {
    const already = await pool.query(
      `SELECT 1 FROM express_automation_log
        WHERE kind = 'payout' AND action = 'cap_reached'
          AND (created_at AT TIME ZONE 'Africa/Lagos')::date = (now() AT TIME ZONE 'Africa/Lagos')::date LIMIT 1`
    );
    if (!already.rowCount) await logEvent(pool, "cap_reached", { capNaira: cap, spentTodayNaira: spent, heldPayouts: held });
  }
  return { enabled: true, paid, paidNaira, held, capNaira: cap };
}

// Admin pays every owed reward now. Explicit, so the daily cap does not apply;
// the caller must confirm. Returns totals.
async function payAllOwed({ adminId, db } = {}) {
  const pool = db || getPool();
  const owed = await pool.query("SELECT id FROM driver_quest_payouts WHERE status = 'owed' ORDER BY earned_at ASC, id ASC");
  let paid = 0;
  let paidNaira = 0;
  for (const row of owed.rows) {
    const r = await payToWallet(row.id, { adminId, db: pool });
    if (r.credited) {
      paid += 1;
      paidNaira += r.rewardNaira;
    }
  }
  return { paid, paidNaira };
}

module.exports = { PayoutError, payToWallet, autoPayOwed, payAllOwed, autoPaidTodayNaira, dailyCapNaira };
