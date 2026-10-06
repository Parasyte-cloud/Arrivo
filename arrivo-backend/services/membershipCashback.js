const { pool: defaultPool } = require("../db/db");

// Premium / Executive membership cashback — a percentage of every
// completed, PAID trip's fare, credited back to the rider's own wallet
// automatically. Keyed off payment_status === 'paid' rather than the
// payment method, so it applies the same way whether the trip was paid by
// card, wallet, or is a ride covered outright by the membership itself
// (payment_method === 'membership' — the rider doesn't pay the fare, but
// still earns cashback on it as a loyalty bonus on top of the free ride;
// see routes/memberships.js for the plan catalogue this cashback_percent
// comes from).
//
// Deliberately its own module rather than inline in routes/rides.js — the
// completion path in rides.js already does a lot in one handler, and this
// is a self-contained "look up membership, credit wallet, log it" step
// that's easier to reason about (and re-test) on its own.
async function creditMembershipCashback(ride, pool = defaultPool) {
  const fareNaira = Number(ride.fare_naira);
  if (!(fareNaira > 0)) return null; // fleet-companion escort legs, etc. — nothing to cash back on

  const membership = await pool.query(
    `SELECT * FROM memberships
     WHERE user_id = $1 AND status = 'active' AND expires_at > now() AND cashback_percent > 0
     ORDER BY expires_at DESC LIMIT 1`,
    [ride.rider_id]
  );
  const plan = membership.rows[0];
  if (!plan) return null;

  const cashbackNaira = Math.round((fareNaira * Number(plan.cashback_percent)) / 100);
  if (cashbackNaira <= 0) return null;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const userResult = await client.query(
      "UPDATE users SET wallet_balance_naira = wallet_balance_naira + $1 WHERE id = $2 RETURNING wallet_balance_naira",
      [cashbackNaira, ride.rider_id]
    );
    const newBalance = Number(userResult.rows[0].wallet_balance_naira);
    await client.query(
      `INSERT INTO wallet_transactions (user_id, type, status, amount_naira, balance_after_naira, ride_id, description)
       VALUES ($1, 'membership_cashback', 'completed', $2, $3, $4, $5)`,
      [ride.rider_id, cashbackNaira, newBalance, ride.id, `${plan.cashback_percent}% membership cashback — Ride #${ride.id}`]
    );
    await client.query("COMMIT");
    return { cashbackNaira, newBalanceNaira: newBalance };
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(`[membership-cashback] failed for ride #${ride.id}, rider ${ride.rider_id}:`, err.message);
    return null;
  } finally {
    client.release();
  }
}

module.exports = { creditMembershipCashback };
