// Driver cash-out: move money from the RideArrivo wallet to the driver's bank.
//
// The money rules, in the order they matter:
//
//  1. The wallet is debited in the SAME transaction that creates the
//     withdrawal row, under a lock on the user row. Two requests at once
//     serialise, so the same naira can never be requested twice.
//  2. Only earnings can leave: the amount that can be withdrawn is capped at
//     what the driver has been CREDITED (quest rewards, admin credits),
//     minus what they already withdrew. Card top-ups and refunds are not
//     counted, so the wallet cannot be used to turn a stolen card into cash.
//  3. Paystack gets our `reference`, which it refuses to accept twice. A retry
//     after a crash or a timeout can therefore never pay twice.
//  4. A transfer that fails, is rejected or is reversed puts the money back
//     in the wallet, exactly once (the row is locked and its status checked).
//  5. When we cannot tell whether Paystack received a request (timeout), the
//     money is NOT refunded. The row stays queued and the sweep retries with
//     the same reference, or verifies it, until the truth is known.
//
// Large requests (CASHOUT_REVIEW_ABOVE_NAIRA) wait for an admin. The whole
// feature is off until driver_cashout_enabled is switched on.

const crypto = require("crypto");
// Lazy so the pure rules can be unit tested with no database.
const getConfigBool = (...a) => require("./systemConfig").getConfigBool(...a);
const { api: paystack, PaystackError } = require("./paystackTransfers");

class CashoutError extends Error {
  // params: the numbers inside the message, so an app can show the same
  // message in the driver's own language.
  constructor(message, status = 400, code = "CASHOUT_ERROR", params = undefined) {
    super(message);
    this.name = "CashoutError";
    this.status = status;
    this.code = code;
    this.params = params;
  }
}

function envNum(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}
function limits() {
  return {
    minNaira: envNum("CASHOUT_MIN_NAIRA", 1000),
    maxNaira: envNum("CASHOUT_MAX_NAIRA", 200000),
    dailyMaxNaira: envNum("CASHOUT_DAILY_MAX_NAIRA", 300000),
    reviewAboveNaira: envNum("CASHOUT_REVIEW_ABOVE_NAIRA", 100000),
    bankCoolingHours: envNum("CASHOUT_BANK_COOLING_HOURS", 24),
    feeNaira: Math.round(envNum("CASHOUT_FEE_NAIRA", 0)),
    maxAttempts: 10,
  };
}

function getPool() {
  return require("../db/db").pool;
}

// ── Pure helpers ─────────────────────────────────────────────────────────

function nameTokens(s) {
  return String(s || "").toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter((t) => t.length >= 2);
}

// The bank's account name must share at least one name with the driver's
// profile name ("LAWAL BIOLA SHERIFF" matches "Biola Lawal").
function namesMatch(accountName, profileName) {
  const a = new Set(nameTokens(accountName));
  return nameTokens(profileName).some((t) => a.has(t));
}

function maskAccount(n) {
  return `******${String(n).slice(-4)}`;
}

function validAccountNumber(n) {
  return /^\d{10}$/.test(String(n || ""));
}

// Pure. What a driver may withdraw right now.
function computeWithdrawable({ balance, creditsEarned, withdrawnActive }) {
  return Math.max(0, Math.min(Number(balance) || 0, (Number(creditsEarned) || 0) - (Number(withdrawnActive) || 0)));
}

// Pure. Checks a request against the limits; returns the first problem as
// { code, message } or null.
function checkRequest({ amount, withdrawable, spentToday, hoursSinceBankChange }, lim = limits()) {
  if (!Number.isInteger(amount) || amount <= 0) return { code: "INVALID_AMOUNT", message: "Enter a whole number of naira." };
  if (amount < lim.minNaira) return { code: "BELOW_MINIMUM", params: { min: lim.minNaira }, message: `The smallest cash-out is ₦${lim.minNaira.toLocaleString()}.` };
  if (amount > lim.maxNaira) return { code: "ABOVE_MAXIMUM", params: { max: lim.maxNaira }, message: `The most you can cash out at once is ₦${lim.maxNaira.toLocaleString()}.` };
  if (hoursSinceBankChange < lim.bankCoolingHours) {
    const wait = Math.ceil(lim.bankCoolingHours - hoursSinceBankChange);
    return { code: "BANK_COOLING_OFF", params: { hours: wait }, message: `You changed your bank account recently. For your safety cash-out opens again in about ${wait} hour${wait === 1 ? "" : "s"}.` };
  }
  if (amount + lim.feeNaira > withdrawable) {
    return { code: "INSUFFICIENT_WITHDRAWABLE", params: { amount: Math.floor(withdrawable) }, message: `You can cash out up to ₦${Math.floor(withdrawable).toLocaleString()} right now. Only earnings can be withdrawn, not money you added.` };
  }
  if (spentToday + amount > lim.dailyMaxNaira) {
    return { code: "DAILY_LIMIT", params: { left: Math.max(lim.dailyMaxNaira - spentToday, 0) }, message: `The daily cash-out limit is ₦${lim.dailyMaxNaira.toLocaleString()}. You have ₦${Math.max(lim.dailyMaxNaira - spentToday, 0).toLocaleString()} left today.` };
  }
  return null;
}

// ── Bank account ─────────────────────────────────────────────────────────

let bankCache = { at: 0, banks: null };
async function listBanks() {
  if (bankCache.banks && Date.now() - bankCache.at < 6 * 3600 * 1000) return bankCache.banks;
  const banks = await paystack.listBanks();
  bankCache = { at: Date.now(), banks };
  return banks;
}

async function saveBankAccount(userId, { bankCode, accountNumber }, db) {
  const pool = db || getPool();
  if (!validAccountNumber(accountNumber)) throw new CashoutError("An account number is 10 digits.", 400, "INVALID_ACCOUNT_NUMBER");
  const banks = await listBanks();
  const bank = banks.find((b) => b.code === String(bankCode));
  if (!bank) throw new CashoutError("Choose your bank from the list.", 400, "UNKNOWN_BANK");

  let resolved;
  try {
    resolved = await paystack.resolveAccount(accountNumber, bank.code);
  } catch (e) {
    if (e instanceof PaystackError && e.status && e.status < 500) {
      throw new CashoutError("We could not find that account. Check the number and the bank.", 422, "ACCOUNT_NOT_FOUND");
    }
    throw new CashoutError("Could not check the account right now. Try again in a moment.", 503, "BANK_LOOKUP_UNAVAILABLE");
  }

  const user = (await pool.query("SELECT name FROM users WHERE id = $1", [userId])).rows[0];
  if (process.env.CASHOUT_REQUIRE_NAME_MATCH !== "false" && !namesMatch(resolved.accountName, user && user.name)) {
    throw new CashoutError(
      "The name on that account does not match the name on your RideArrivo profile. Use an account in your own name, or contact support.",
      422, "NAME_MISMATCH"
    );
  }

  const existing = (await pool.query("SELECT bank_code, account_number FROM driver_bank_accounts WHERE user_id = $1", [userId])).rows[0];
  if (existing && existing.bank_code === bank.code && existing.account_number === String(accountNumber)) {
    return publicBank((await pool.query("SELECT * FROM driver_bank_accounts WHERE user_id = $1", [userId])).rows[0]);
  }

  let recipient;
  try {
    recipient = await paystack.createRecipient({ name: resolved.accountName, accountNumber, bankCode: bank.code });
  } catch (e) {
    throw new CashoutError("Could not save the account right now. Try again in a moment.", 503, "RECIPIENT_UNAVAILABLE");
  }

  const r = await pool.query(
    `INSERT INTO driver_bank_accounts (user_id, bank_code, bank_name, account_number, account_name, paystack_recipient_code)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id) DO UPDATE SET bank_code = EXCLUDED.bank_code, bank_name = EXCLUDED.bank_name,
       account_number = EXCLUDED.account_number, account_name = EXCLUDED.account_name,
       paystack_recipient_code = EXCLUDED.paystack_recipient_code, changed_at = now()
     RETURNING *`,
    [userId, bank.code, bank.name, String(accountNumber), resolved.accountName, recipient.recipientCode]
  );
  return publicBank(r.rows[0]);
}

function publicBank(row) {
  if (!row) return null;
  return {
    bankName: row.bank_name,
    accountName: row.account_name,
    accountMasked: maskAccount(row.account_number),
    changedAt: row.changed_at,
  };
}

// ── Balance and summary ──────────────────────────────────────────────────

async function withdrawableFor(userId, db) {
  const r = await (db || getPool()).query(
    `SELECT u.wallet_balance_naira AS balance,
            coalesce((SELECT sum(amount_naira) FROM wallet_transactions
                       WHERE user_id = u.id AND type = 'credit' AND status = 'completed' AND amount_naira > 0), 0) AS credits,
            coalesce((SELECT sum(amount_naira + fee_naira) FROM wallet_withdrawals
                       WHERE user_id = u.id AND status NOT IN ('failed','rejected','reversed')), 0) AS withdrawn
       FROM users u WHERE u.id = $1`,
    [userId]
  );
  const row = r.rows[0];
  return {
    balance: Number(row.balance),
    withdrawable: computeWithdrawable({ balance: row.balance, creditsEarned: row.credits, withdrawnActive: row.withdrawn }),
  };
}

async function spentTodayNaira(userId, db) {
  const r = await (db || getPool()).query(
    `SELECT coalesce(sum(amount_naira), 0)::bigint AS total FROM wallet_withdrawals
      WHERE user_id = $1 AND status NOT IN ('failed','rejected','reversed')
        AND (requested_at AT TIME ZONE 'Africa/Lagos')::date = (now() AT TIME ZONE 'Africa/Lagos')::date`,
    [userId]
  );
  return Number(r.rows[0].total);
}

const STATUS_LABEL = {
  pending_review: "Waiting for review",
  queued: "Sending",
  processing: "On its way",
  paid: "Paid",
  failed: "Failed, money returned",
  rejected: "Declined, money returned",
  reversed: "Reversed, money returned",
};

async function summary(userId, db) {
  const pool = db || getPool();
  const lim = limits();
  const bank = (await pool.query("SELECT * FROM driver_bank_accounts WHERE user_id = $1", [userId])).rows[0];
  const { balance, withdrawable } = await withdrawableFor(userId, pool);
  const history = (await pool.query(
    `SELECT id, amount_naira, fee_naira, status, bank_name, account_last4, requested_at, processed_at, note
       FROM wallet_withdrawals WHERE user_id = $1 ORDER BY requested_at DESC, id DESC LIMIT 20`,
    [userId]
  )).rows.map((w) => ({
    id: w.id, amountNaira: w.amount_naira, feeNaira: w.fee_naira, status: w.status, statusLabel: STATUS_LABEL[w.status],
    bankName: w.bank_name, accountLast4: w.account_last4, requestedAt: w.requested_at, processedAt: w.processed_at,
  }));
  return {
    enabled: await getConfigBool("driver_cashout_enabled", false),
    balanceNaira: balance,
    withdrawableNaira: Math.floor(withdrawable),
    bank: publicBank(bank),
    limits: { minNaira: lim.minNaira, maxNaira: lim.maxNaira, dailyMaxNaira: lim.dailyMaxNaira, feeNaira: lim.feeNaira, reviewAboveNaira: lim.reviewAboveNaira, bankCoolingHours: lim.bankCoolingHours },
    history,
  };
}

// ── Requesting a cash-out ────────────────────────────────────────────────

async function requestCashout(userId, { amountNaira, idempotencyKey } = {}, db) {
  const pool = db || getPool();
  if (!(await getConfigBool("driver_cashout_enabled", false))) {
    throw new CashoutError("Cash-out is not open yet.", 503, "CASHOUT_DISABLED");
  }
  const amount = Number(amountNaira);
  const lim = limits();
  const key = idempotencyKey ? String(idempotencyKey).slice(0, 80) : null;

  const client = await pool.connect();
  let created;
  try {
    await client.query("BEGIN");
    // Serialise everything that moves this user's money.
    await client.query("SELECT 1 FROM users WHERE id = $1 FOR UPDATE", [userId]);

    if (key) {
      const prior = await client.query("SELECT id, status, amount_naira FROM wallet_withdrawals WHERE user_id = $1 AND idempotency_key = $2", [userId, key]);
      if (prior.rows[0]) {
        await client.query("COMMIT");
        return { id: prior.rows[0].id, status: prior.rows[0].status, amountNaira: prior.rows[0].amount_naira, duplicate: true };
      }
    }

    const bank = (await client.query("SELECT * FROM driver_bank_accounts WHERE user_id = $1", [userId])).rows[0];
    if (!bank) throw new CashoutError("Add your bank account first.", 400, "NO_BANK_ACCOUNT");

    const { withdrawable } = await withdrawableFor(userId, client);
    const spentToday = await spentTodayNaira(userId, client);
    const hoursSinceBankChange = (Date.now() - new Date(bank.changed_at).getTime()) / 3600000;
    const problem = checkRequest({ amount, withdrawable, spentToday, hoursSinceBankChange }, lim);
    if (problem) throw new CashoutError(problem.message, 400, problem.code, problem.params);

    const total = amount + lim.feeNaira;
    const bal = await client.query("UPDATE users SET wallet_balance_naira = wallet_balance_naira - $1 WHERE id = $2 AND wallet_balance_naira >= $1 RETURNING wallet_balance_naira", [total, userId]);
    if (!bal.rowCount) throw new CashoutError("Your wallet balance is too low.", 400, "INSUFFICIENT_BALANCE");

    const reference = `co-${Date.now().toString(36)}-${crypto.randomBytes(6).toString("hex")}`;
    const tx = await client.query(
      `INSERT INTO wallet_transactions (user_id, type, status, amount_naira, balance_after_naira, description)
       VALUES ($1, 'withdrawal', 'completed', $2, $3, $4) RETURNING id`,
      [userId, -total, Number(bal.rows[0].wallet_balance_naira), `Cash-out to ${bank.bank_name} ${maskAccount(bank.account_number)}`]
    );
    const needsReview = amount > lim.reviewAboveNaira;
    const w = await client.query(
      `INSERT INTO wallet_withdrawals
         (user_id, amount_naira, fee_naira, status, reference, idempotency_key, bank_name, account_last4, account_name,
          paystack_recipient_code, debit_transaction_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id, status, amount_naira`,
      [userId, amount, lim.feeNaira, needsReview ? "pending_review" : "queued", reference, key, bank.bank_name,
       String(bank.account_number).slice(-4), bank.account_name, bank.paystack_recipient_code, tx.rows[0].id]
    );
    await client.query("COMMIT");
    created = w.rows[0];
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch (_) { /* already rolled back */ }
    throw error;
  } finally {
    client.release();
  }

  // Outside the transaction: a slow Paystack must not hold the user lock.
  if (created.status === "queued") {
    await sendTransfer(created.id, pool).catch((e) => console.error(`Cash-out #${created.id} send failed (stays queued):`, e.message));
  }
  const now = (await pool.query("SELECT status FROM wallet_withdrawals WHERE id = $1", [created.id])).rows[0];
  return { id: created.id, status: now.status, statusLabel: STATUS_LABEL[now.status], amountNaira: created.amount_naira };
}

// ── Sending and settling ─────────────────────────────────────────────────

// Gives the money back, once. Caller holds the row lock inside `client`'s
// transaction and has checked the status.
async function refundWithdrawal(client, w, newStatus, note) {
  const total = Number(w.amount_naira) + Number(w.fee_naira);
  const bal = await client.query("UPDATE users SET wallet_balance_naira = wallet_balance_naira + $1 WHERE id = $2 RETURNING wallet_balance_naira", [total, w.user_id]);
  const tx = await client.query(
    `INSERT INTO wallet_transactions (user_id, type, status, amount_naira, balance_after_naira, description)
     VALUES ($1, 'withdrawal_reversal', 'completed', $2, $3, $4) RETURNING id`,
    [w.user_id, total, Number(bal.rows[0].wallet_balance_naira), `Cash-out returned to wallet${note ? `: ${note}` : ""}`]
  );
  await client.query(
    "UPDATE wallet_withdrawals SET status = $2, refund_transaction_id = $3, note = $4, processed_at = now() WHERE id = $1",
    [w.id, newStatus, tx.rows[0].id, note || null]
  );
}

// outcome: 'success' | 'failed' | 'reversed'. Safe to call any number of
// times, from the webhook, the sweep and an admin, in any order.
async function settleByReference(reference, outcome, { transferCode, reason } = {}, db) {
  const pool = db || getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query("SELECT * FROM wallet_withdrawals WHERE reference = $1 FOR UPDATE", [reference]);
    const w = found.rows[0];
    if (!w) { await client.query("ROLLBACK"); return { found: false }; }

    let result = { found: true, id: w.id, changed: false, status: w.status };
    if (outcome === "success") {
      if (["queued", "processing"].includes(w.status)) {
        await client.query("UPDATE wallet_withdrawals SET status = 'paid', paystack_transfer_code = coalesce($2, paystack_transfer_code), processed_at = now(), note = NULL WHERE id = $1", [w.id, transferCode || null]);
        result = { found: true, id: w.id, changed: true, status: "paid" };
      }
    } else if (outcome === "failed" || outcome === "reversed") {
      // A reversal can arrive after a success; money comes back either way.
      if (["queued", "processing", "paid"].includes(w.status)) {
        const status = outcome === "reversed" ? "reversed" : "failed";
        await refundWithdrawal(client, w, status, reason || (outcome === "reversed" ? "bank reversed the transfer" : "transfer failed"));
        result = { found: true, id: w.id, changed: true, status };
      }
    }
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch (_) { /* already rolled back */ }
    throw error;
  } finally {
    client.release();
  }
}

// Asks Paystack to pay a queued withdrawal. Never throws for expected
// Paystack outcomes; the row's state records what happened.
async function sendTransfer(withdrawalId, db) {
  const pool = db || getPool();
  const lim = limits();

  // Claim the attempt so two senders cannot both call Paystack.
  const claim = await pool.query(
    `UPDATE wallet_withdrawals SET attempts = attempts + 1, last_attempt_at = now()
      WHERE id = $1 AND status = 'queued' AND attempts < $2
      RETURNING *`,
    [withdrawalId, lim.maxAttempts]
  );
  const w = claim.rows[0];
  if (!w) return { sent: false, reason: "not_queued" };

  let result;
  try {
    result = await paystack.initiateTransfer({
      amountNaira: w.amount_naira, recipientCode: w.paystack_recipient_code, reference: w.reference,
      reason: "RideArrivo driver cash-out",
    });
  } catch (e) {
    const msg = String((e && e.message) || "");
    if (e instanceof PaystackError && /reference/i.test(msg) && /exist|already|duplicate/i.test(msg)) {
      return verifyAndSettle(w.id, pool); // Paystack already has it: ask what happened
    }
    if (e instanceof PaystackError && !e.network && e.status && e.status < 500) {
      if (/balance/i.test(msg)) {
        // Our Paystack balance is short. Nothing was sent; the driver's money
        // is safe in the withdrawal. Keep it queued and tell the admin.
        await pool.query("UPDATE wallet_withdrawals SET note = $2 WHERE id = $1", [w.id, "Paystack balance too low, will retry"]);
        return { sent: false, reason: "paystack_balance" };
      }
      // A definite refusal (bad recipient, invalid amount): give the money back.
      return settleByReference(w.reference, "failed", { reason: msg.slice(0, 120) }, pool);
    }
    // Network error or Paystack 5xx: we do not know. Never refund on a guess.
    await pool.query("UPDATE wallet_withdrawals SET note = $2 WHERE id = $1", [w.id, "Waiting to confirm with Paystack"]);
    return { sent: false, reason: "unconfirmed" };
  }

  if (result.status === "success") return settleByReference(w.reference, "success", { transferCode: result.transferCode }, pool);
  if (result.status === "failed" || result.status === "reversed") return settleByReference(w.reference, result.status, { transferCode: result.transferCode }, pool);

  const note = result.status === "otp" ? "Paystack is waiting for an OTP. Turn off transfer confirmation in the Paystack dashboard." : null;
  await pool.query(
    "UPDATE wallet_withdrawals SET status = 'processing', paystack_transfer_code = $2, note = $3 WHERE id = $1 AND status = 'queued'",
    [w.id, result.transferCode || null, note]
  );
  return { sent: true, status: "processing" };
}

async function verifyAndSettle(withdrawalId, db) {
  const pool = db || getPool();
  const w = (await pool.query("SELECT * FROM wallet_withdrawals WHERE id = $1", [withdrawalId])).rows[0];
  if (!w) return { found: false };
  let v;
  try {
    v = await paystack.verifyTransfer(w.reference);
  } catch (e) {
    return { verified: false, reason: e.message };
  }
  if (v.status === "success") return settleByReference(w.reference, "success", { transferCode: v.transferCode }, pool);
  if (v.status === "failed" || v.status === "reversed") return settleByReference(w.reference, v.status, { transferCode: v.transferCode }, pool);
  await pool.query("UPDATE wallet_withdrawals SET status = 'processing', paystack_transfer_code = coalesce($2, paystack_transfer_code) WHERE id = $1 AND status = 'queued'", [w.id, v.transferCode || null]);
  return { verified: true, status: v.status };
}

// Runs from the scheduler. Retries sends that did not go through and checks
// transfers that have been in flight a while (a missed webhook must not leave
// a driver waiting forever).
async function sweepCashouts({ db } = {}) {
  const pool = db || getPool();
  const queued = await pool.query(
    "SELECT id FROM wallet_withdrawals WHERE status = 'queued' AND (last_attempt_at IS NULL OR last_attempt_at < now() - interval '2 minutes') ORDER BY requested_at LIMIT 50"
  );
  for (const row of queued.rows) await sendTransfer(row.id, pool).catch((e) => console.error(`Cash-out #${row.id} retry failed:`, e.message));
  const inflight = await pool.query(
    "SELECT id FROM wallet_withdrawals WHERE status = 'processing' AND coalesce(last_attempt_at, requested_at) < now() - interval '10 minutes' ORDER BY requested_at LIMIT 50"
  );
  for (const row of inflight.rows) await verifyAndSettle(row.id, pool).catch((e) => console.error(`Cash-out #${row.id} verify failed:`, e.message));
  return { retried: queued.rowCount, checked: inflight.rowCount };
}

// ── Admin ────────────────────────────────────────────────────────────────

async function listForAdmin({ status, db } = {}) {
  const r = await (db || getPool()).query(
    `SELECT w.id, w.user_id AS "userId", u.name AS "driverName", u.phone AS "driverPhone", w.amount_naira AS "amountNaira",
            w.fee_naira AS "feeNaira", w.status, w.bank_name AS "bankName", w.account_last4 AS "accountLast4",
            w.account_name AS "accountName", w.attempts, w.note, w.requested_at AS "requestedAt", w.processed_at AS "processedAt"
       FROM wallet_withdrawals w JOIN users u ON u.id = w.user_id
      WHERE ($1::text IS NULL OR w.status = $1)
      ORDER BY w.requested_at DESC, w.id DESC LIMIT 200`,
    [status || null]
  );
  return r.rows;
}

async function approve(withdrawalId, adminId, db) {
  const pool = db || getPool();
  const r = await pool.query(
    "UPDATE wallet_withdrawals SET status = 'queued', reviewed_by = $2, note = NULL WHERE id = $1 AND status = 'pending_review' RETURNING id",
    [withdrawalId, adminId]
  );
  if (!r.rowCount) throw new CashoutError("This cash-out is not waiting for review.", 409, "NOT_PENDING_REVIEW");
  await sendTransfer(withdrawalId, pool).catch((e) => console.error(`Cash-out #${withdrawalId} send failed (stays queued):`, e.message));
  return { id: withdrawalId, status: (await pool.query("SELECT status FROM wallet_withdrawals WHERE id = $1", [withdrawalId])).rows[0].status };
}

async function reject(withdrawalId, adminId, reason, db) {
  const pool = db || getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const w = (await client.query("SELECT * FROM wallet_withdrawals WHERE id = $1 FOR UPDATE", [withdrawalId])).rows[0];
    if (!w) throw new CashoutError("Cash-out not found.", 404, "NOT_FOUND");
    if (w.status !== "pending_review") throw new CashoutError("Only a cash-out waiting for review can be declined.", 409, "NOT_PENDING_REVIEW");
    await refundWithdrawal(client, w, "rejected", String(reason || "declined by RideArrivo").slice(0, 200));
    await client.query("UPDATE wallet_withdrawals SET reviewed_by = $2 WHERE id = $1", [w.id, adminId]);
    await client.query("COMMIT");
    return { id: w.id, status: "rejected" };
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch (_) { /* already rolled back */ }
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  CashoutError, limits, namesMatch, maskAccount, validAccountNumber, computeWithdrawable, checkRequest,
  listBanks, saveBankAccount, summary, requestCashout, settleByReference, sendTransfer, verifyAndSettle,
  sweepCashouts, listForAdmin, approve, reject,
};
