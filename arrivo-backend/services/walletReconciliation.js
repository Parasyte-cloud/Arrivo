// The daily wallet balance check.
//
// Customer money is held in ONE account (the wallet funds / holding account). What that account should hold is
// everything RideArrivo owes riders plus everything spent but not yet moved to a service account:
//
//   expected = rider wallet balances
//            + money held for trips in progress (already off the balance, not yet spent)
//            + money spent on a service but not yet settled to that service's account
//
// Driver earnings wallets are NOT in this number: they are RideArrivo's debt to drivers, paid from the payout float,
// and are reported next to it so nobody mixes the two.
//
// Two kinds of check:
//   * inside the books (no bank needed): ledger against balance, stale holds, settlements overdue, top-ups that did not
//     land in the holding account. Run by the daily job.
//   * against the bank: finance types in the real holding-account balance; the difference is stored.
// A mismatch is never "fixed" by this code. It is recorded and flagged for a person.

const { pool } = require("../db/db");
const { sendEmail } = require("./email");

class ReconciliationError extends Error {
  constructor(message, status = 400, code = "RECON_ERROR") {
    super(message);
    this.name = "ReconciliationError";
    this.status = status;
    this.code = code;
  }
}

const num = (v) => Number(v);
const money = (v) => Math.round(num(v) * 100) / 100;
const toleranceNaira = () => Math.max(0, Number(process.env.WALLET_RECON_TOLERANCE_NAIRA) || 0);
const maxSettlementAgeDays = () => Math.max(1, Number(process.env.WALLET_SETTLEMENT_MAX_AGE_DAYS) || 8);
const reconHourLagos = () => {
  const h = Number(process.env.WALLET_RECON_HOUR_LAGOS);
  return Number.isInteger(h) && h >= 0 && h <= 23 ? h : 20;
};

async function lagosDay(db = pool) {
  return (await db.query("SELECT (now() AT TIME ZONE 'Africa/Lagos')::date AS d")).rows[0].d;
}

// What the holding account should hold right now, and why.
async function computeLive(db = pool) {
  const balances = await db.query(
    `SELECT COALESCE(SUM(wallet_balance_naira) FILTER (WHERE role <> 'driver'), 0) AS riders,
            COALESCE(SUM(wallet_balance_naira) FILTER (WHERE role = 'driver'), 0) AS drivers
       FROM users`
  );
  const held = await db.query("SELECT COALESCE(SUM(amount_naira), 0) AS total FROM wallet_holds WHERE status = 'held'");
  // Spent but still in the holding account: not in any settlement, or in one nobody has approved yet.
  const unsettled = await db.query(
    `SELECT h.service, COALESCE(SUM(h.captured_amount_naira), 0) AS total, MIN(h.captured_at) AS oldest
       FROM wallet_holds h LEFT JOIN wallet_settlements s ON s.id = h.settlement_id
      WHERE h.status = 'captured' AND (h.settlement_id IS NULL OR s.status = 'pending')
      GROUP BY h.service ORDER BY h.service`
  );
  const riders = money(balances.rows[0].riders);
  const heldNaira = money(held.rows[0].total);
  const unsettledNaira = money(unsettled.rows.reduce((a, r) => a + num(r.total), 0));
  return {
    riderBalancesNaira: riders,
    heldNaira,
    unsettledNaira,
    expectedNaira: money(riders + heldNaira + unsettledNaira),
    driverWalletsNaira: money(balances.rows[0].drivers),
    unsettledByService: unsettled.rows.map((r) => ({ service: r.service, naira: money(r.total), oldest: r.oldest })),
  };
}

// Findings that need no bank figure. Each is { code, severity, message, ... }.
async function integrityFindings(db = pool) {
  const out = [];

  const drift = await db.query(
    `SELECT u.id, u.wallet_balance_naira AS balance, COALESCE(t.total, 0) AS ledger
       FROM users u
       LEFT JOIN (SELECT user_id, SUM(amount_naira) AS total FROM wallet_transactions WHERE status = 'completed' GROUP BY user_id) t
              ON t.user_id = u.id
      WHERE u.role = 'rider' AND u.wallet_balance_naira <> COALESCE(t.total, 0)
      ORDER BY abs(u.wallet_balance_naira - COALESCE(t.total, 0)) DESC LIMIT 20`
  );
  if (drift.rows.length) {
    out.push({
      code: "ledger_drift",
      severity: "high",
      message: `${drift.rows.length} rider wallet(s) where the balance does not equal the sum of its ledger entries.`,
      sample: drift.rows.map((r) => ({ userId: r.id, balanceNaira: money(r.balance), ledgerNaira: money(r.ledger) })),
    });
  }

  const stale = await db.query(
    "SELECT COUNT(*) AS n, COALESCE(SUM(amount_naira), 0) AS total FROM wallet_holds WHERE status = 'held' AND expires_at < now() - interval '1 hour'"
  );
  if (num(stale.rows[0].n) > 0) {
    out.push({
      code: "stale_holds",
      severity: "medium",
      message: `${stale.rows[0].n} hold(s) are past their expiry and still open. The expiry sweep may not be running.`,
      count: num(stale.rows[0].n),
      naira: money(stale.rows[0].total),
    });
  }

  const aging = await db.query(
    `SELECT service, MIN(captured_at) AS oldest, SUM(captured_amount_naira) AS total
       FROM wallet_holds WHERE status = 'captured' AND settlement_id IS NULL AND captured_amount_naira > 0
      GROUP BY service HAVING MIN(captured_at) < now() - ($1 || ' days')::interval`,
    [String(maxSettlementAgeDays())]
  );
  for (const r of aging.rows) {
    out.push({
      code: "settlement_overdue",
      severity: "medium",
      message: `${r.service}: ${money(r.total)} naira spent more than ${maxSettlementAgeDays()} days ago has not been settled.`,
      service: r.service,
      naira: money(r.total),
      oldest: r.oldest,
    });
  }

  // Top-ups credited with the money NOT in the holding account. Only meaningful once routing is live (the first
  // routed top-up exists); before that every top-up is "direct" and the list would be noise.
  const live = await db.query("SELECT MIN(created_at) AS since FROM wallet_transactions WHERE type = 'topup' AND funding_route = 'holding'");
  if (live.rows[0].since) {
    const direct = await db.query(
      `SELECT COUNT(*) AS n, COALESCE(SUM(amount_naira), 0) AS total
         FROM wallet_transactions
        WHERE type = 'topup' AND status = 'completed' AND created_at >= $1 AND funding_route IS DISTINCT FROM 'holding'`,
      [live.rows[0].since]
    );
    if (num(direct.rows[0].n) > 0) {
      out.push({
        code: "topups_not_in_holding",
        severity: "high",
        message: `${direct.rows[0].n} top-up(s) worth ${money(direct.rows[0].total)} naira were credited to wallets but did not settle into the holding account. Move that money across.`,
        count: num(direct.rows[0].n),
        naira: money(direct.rows[0].total),
      });
    }
  }
  return out;
}

function statusFor(findings, difference) {
  if (difference != null && Math.abs(difference) > toleranceNaira()) return "mismatch";
  return findings.length ? "attention" : "ok";
}

function shape(r) {
  return {
    id: r.id,
    kind: r.kind,
    day: r.lagos_day,
    expectedNaira: money(r.expected_naira),
    riderBalancesNaira: money(r.rider_balances_naira),
    heldNaira: money(r.held_naira),
    unsettledNaira: money(r.unsettled_naira),
    driverWalletsNaira: money(r.driver_wallets_naira),
    bankBalanceNaira: r.bank_balance_naira == null ? null : money(r.bank_balance_naira),
    differenceNaira: r.difference_naira == null ? null : money(r.difference_naira),
    status: r.status,
    findings: r.findings,
    recordedBy: r.recorded_by,
    note: r.note,
    createdAt: r.created_at,
  };
}

// Finance types in the real holding-account balance. difference = bank - expected: negative means the bank holds
// LESS than it should (money missing), positive means more (an unrecorded top-up, say).
async function recordBankBalance({ bankBalanceNaira, adminId, note }) {
  const bank = Number(bankBalanceNaira);
  if (!Number.isFinite(bank) || bank < 0 || bank > 100_000_000_000) throw new ReconciliationError("Enter the holding account balance in naira.", 400, "BAD_BALANCE");
  const cleanNote = typeof note === "string" ? note.trim().slice(0, 300) || null : null;
  const client = await pool.connect();
  try {
    // One consistent snapshot: every figure below is read as of the same instant, even while wallets move.
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ WRITE");
    const live = await computeLive(client);
    const findings = await integrityFindings(client);
    const difference = money(bank - live.expectedNaira);
    const status = statusFor(findings, difference);
    if (status === "mismatch") findings.unshift({ code: "bank_mismatch", severity: "high", message: `The bank holds ${difference > 0 ? "more" : "less"} than the ledger says by ${Math.abs(difference)} naira.`, differenceNaira: difference });
    const day = await lagosDay(client);
    const r = await client.query(
      `INSERT INTO wallet_reconciliations
         (kind, lagos_day, expected_naira, rider_balances_naira, held_naira, unsettled_naira, driver_wallets_naira,
          bank_balance_naira, difference_naira, status, findings, recorded_by, note)
       VALUES ('bank', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12) RETURNING *`,
      [day, live.expectedNaira, live.riderBalancesNaira, live.heldNaira, live.unsettledNaira, live.driverWalletsNaira,
       bank, difference, status, JSON.stringify(findings), adminId, cleanNote]
    );
    await client.query("COMMIT");
    if (status === "mismatch") await alertFinance(`Wallet holding account MISMATCH of ${difference} naira`, findings).catch(() => {});
    return shape(r.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// Once per Lagos day, after the configured hour: write the snapshot, and say so if anything needs a person.
async function runDaily({ db = pool } = {}) {
  const hour = Number((await db.query("SELECT EXTRACT(hour FROM now() AT TIME ZONE 'Africa/Lagos') AS h")).rows[0].h);
  if (hour < reconHourLagos()) return { ran: false, reason: "too_early" };
  const day = await lagosDay(db);
  const existing = await db.query("SELECT id FROM wallet_reconciliations WHERE kind = 'snapshot' AND lagos_day = $1", [day]);
  if (existing.rows[0]) return { ran: false, reason: "done_today" };

  const live = await computeLive(db);
  const findings = await integrityFindings(db);
  const bankToday = await db.query(
    "SELECT status FROM wallet_reconciliations WHERE kind = 'bank' AND lagos_day = $1 ORDER BY id DESC LIMIT 1",
    [day]
  );
  if (!bankToday.rows[0]) {
    findings.push({ code: "bank_balance_not_recorded", severity: "medium", message: "Nobody recorded the real holding account balance today." });
  } else if (bankToday.rows[0].status === "mismatch") {
    findings.push({ code: "bank_mismatch_today", severity: "high", message: "Today's recorded bank balance did not match the ledger." });
  }
  const status = findings.some((f) => f.code === "bank_mismatch_today") ? "mismatch" : findings.length ? "attention" : "ok";
  const r = await db.query(
    `INSERT INTO wallet_reconciliations
       (kind, lagos_day, expected_naira, rider_balances_naira, held_naira, unsettled_naira, driver_wallets_naira, status, findings)
     VALUES ('snapshot', $1, $2, $3, $4, $5, $6, $7, $8::jsonb)
     ON CONFLICT (lagos_day) WHERE kind = 'snapshot' DO NOTHING RETURNING *`,
    [day, live.expectedNaira, live.riderBalancesNaira, live.heldNaira, live.unsettledNaira, live.driverWalletsNaira, status, JSON.stringify(findings)]
  );
  if (!r.rows[0]) return { ran: false, reason: "done_today" };
  if (status !== "ok") await alertFinance(`Wallet daily check: ${status}`, findings).catch((e) => console.error("[wallet recon] alert failed:", e.message));
  return { ran: true, status, findings: findings.length };
}

async function alertFinance(subject, findings) {
  const to = process.env.WALLET_ALERT_EMAIL;
  console.warn(`[wallet recon] ${subject}: ${JSON.stringify(findings).slice(0, 800)}`);
  if (!to) return;
  const rows = findings.map((f) => `<li><b>${String(f.code)}</b> (${String(f.severity)}): ${String(f.message).replace(/[<>&]/g, "")}</li>`).join("");
  await sendEmail({ to, subject: `[RideArrivo] ${subject}`, html: `<p>Open the finance wallet screen for the full detail.</p><ul>${rows}</ul>` });
}

async function overview() {
  const live = await computeLive();
  const findings = await integrityFindings();
  const history = await pool.query("SELECT * FROM wallet_reconciliations ORDER BY id DESC LIMIT 30");
  return { live, findings, history: history.rows.map(shape) };
}

module.exports = { ReconciliationError, computeLive, integrityFindings, recordBankBalance, runDaily, overview, alertFinance };
