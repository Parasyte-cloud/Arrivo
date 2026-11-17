// Settlement and payout float, for the finance screens. Admin only.
//
// A captured hold is money a rider spent in another service. It sits in the
// wallet funds account until a settlement moves it to that service's account.
// A settlement is made by one admin and approved by a different one (maker and
// checker); the actual bank transfer is done by a person, and the approval
// records the bank reference. A hold belongs to at most one settlement, so a
// trip can never be settled twice.

const { pool } = require("../db/db");

class SettlementError extends Error {
  constructor(message, status = 400, code = "SETTLEMENT_ERROR") {
    super(message);
    this.name = "SettlementError";
    this.status = status;
    this.code = code;
  }
}

const SERVICES = ["express"];

async function inTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// What each service is owed, what is still set aside, and what is awaiting approval.
async function report() {
  const r = await pool.query(
    `SELECT service,
            COALESCE(SUM(captured_amount_naira) FILTER (WHERE status = 'captured' AND settlement_id IS NULL AND captured_amount_naira > 0), 0) AS unsettled_naira,
            COUNT(*) FILTER (WHERE status = 'captured' AND settlement_id IS NULL AND captured_amount_naira > 0) AS unsettled_count,
            COALESCE(SUM(amount_naira) FILTER (WHERE status = 'held'), 0) AS held_naira,
            COUNT(*) FILTER (WHERE status = 'held') AS held_count
       FROM wallet_holds GROUP BY service ORDER BY service`
  );
  return r.rows.map((row) => ({
    service: row.service,
    unsettledNaira: Number(row.unsettled_naira),
    unsettledCount: Number(row.unsettled_count),
    heldNaira: Number(row.held_naira),
    heldCount: Number(row.held_count),
  }));
}

async function list() {
  const r = await pool.query("SELECT * FROM wallet_settlements ORDER BY id DESC LIMIT 100");
  return r.rows.map(shape);
}

function shape(row) {
  return {
    id: row.id,
    service: row.service,
    amountNaira: Number(row.amount_naira),
    holdCount: row.hold_count,
    status: row.status,
    createdBy: row.created_by,
    approvedBy: row.approved_by,
    bankReference: row.bank_reference,
    createdAt: row.created_at,
    approvedAt: row.approved_at,
  };
}

async function create({ service, adminId }) {
  if (!SERVICES.includes(service)) throw new SettlementError("Unknown service.", 400, "BAD_SERVICE");
  return inTransaction(async (client) => {
    const holds = await client.query(
      `SELECT id, captured_amount_naira FROM wallet_holds
        WHERE service = $1 AND status = 'captured' AND settlement_id IS NULL AND captured_amount_naira > 0
        FOR UPDATE`,
      [service]
    );
    if (!holds.rows.length) throw new SettlementError("Nothing to settle for that service.", 409, "NOTHING_TO_SETTLE");
    const total = holds.rows.reduce((sum, h) => sum + Number(h.captured_amount_naira), 0);
    const s = await client.query(
      `INSERT INTO wallet_settlements (service, amount_naira, hold_count, created_by)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [service, total, holds.rows.length, adminId]
    );
    await client.query("UPDATE wallet_holds SET settlement_id = $1 WHERE id = ANY($2::int[])", [s.rows[0].id, holds.rows.map((h) => h.id)]);
    return shape(s.rows[0]);
  });
}

async function approve({ id, adminId, bankReference }) {
  const ref = typeof bankReference === "string" ? bankReference.trim() : "";
  if (ref.length < 4 || ref.length > 120) throw new SettlementError("Enter the bank transfer reference.", 400, "BAD_REFERENCE");
  return inTransaction(async (client) => {
    const r = await client.query("SELECT * FROM wallet_settlements WHERE id = $1 FOR UPDATE", [id]);
    const s = r.rows[0];
    if (!s) throw new SettlementError("Settlement not found.", 404, "NOT_FOUND");
    if (s.status !== "pending") throw new SettlementError(`That settlement is already ${s.status}.`, 409, "NOT_PENDING");
    if (s.created_by === adminId) {
      throw new SettlementError("A different admin must approve a settlement you created.", 403, "SAME_PERSON");
    }
    const upd = await client.query(
      `UPDATE wallet_settlements SET status = 'approved', approved_by = $1, approved_at = now(), bank_reference = $2
        WHERE id = $3 RETURNING *`,
      [adminId, ref, id]
    );
    return shape(upd.rows[0]);
  });
}

// Cancelling frees its holds so the next settlement picks them up again.
async function cancel({ id }) {
  return inTransaction(async (client) => {
    const r = await client.query("SELECT * FROM wallet_settlements WHERE id = $1 FOR UPDATE", [id]);
    const s = r.rows[0];
    if (!s) throw new SettlementError("Settlement not found.", 404, "NOT_FOUND");
    if (s.status !== "pending") throw new SettlementError(`That settlement is already ${s.status}.`, 409, "NOT_PENDING");
    await client.query("UPDATE wallet_holds SET settlement_id = NULL WHERE settlement_id = $1", [id]);
    const upd = await client.query("UPDATE wallet_settlements SET status = 'cancelled' WHERE id = $1 RETURNING *", [id]);
    return shape(upd.rows[0]);
  });
}

// How much cash the payout account should hold. Based on what drivers really
// withdrew over the last 30 days: enough for two of the busiest normal days
// (95th percentile) plus whatever is already waiting to go out.
async function payoutFloat() {
  const daily = await pool.query(
    `SELECT date_trunc('day', processed_at AT TIME ZONE 'Africa/Lagos') AS day, SUM(amount_naira) AS total
       FROM wallet_withdrawals
      WHERE status = 'paid' AND processed_at > now() - interval '30 days'
      GROUP BY 1 ORDER BY 1`
  );
  const totals = daily.rows.map((d) => Number(d.total)).sort((a, b) => a - b);
  const days = totals.length;
  const average = days ? Math.round(totals.reduce((a, b) => a + b, 0) / days) : 0;
  const p95 = days ? totals[Math.min(days - 1, Math.ceil(days * 0.95) - 1)] : 0;
  const open = await pool.query(
    "SELECT COALESCE(SUM(amount_naira), 0) AS total FROM wallet_withdrawals WHERE status IN ('pending_review', 'queued', 'processing')"
  );
  const waiting = Number(open.rows[0].total);
  return {
    daysWithPayouts: days,
    averageDailyNaira: average,
    busyDayNaira: p95,
    waitingToGoOutNaira: waiting,
    recommendedFloatNaira: p95 * 2 + waiting,
    note: days < 7 ? "Fewer than 7 days of payouts so far; treat this as a rough guide." : "Two busy days plus what is waiting to go out.",
  };
}

module.exports = { SettlementError, report, list, create, approve, cancel, payoutFloat, SERVICES };
