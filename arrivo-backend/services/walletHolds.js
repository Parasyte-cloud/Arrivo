// Wallet holds: set a rider's money aside for one trip in another service,
// keep it when the trip completes, give it back when the trip does not.
//
//   placeHold  debits the wallet at once (so held money cannot be spent twice)
//   capture    keeps it; a smaller final amount returns the difference
//   release    returns all of it
//   expireStale  releases holds nobody closed (a crashed trip never strands money)
//
// Every call is idempotent: the caller sends an idempotencyKey (and a trip
// reference), a retry returns the first result instead of acting twice. A
// service can only touch its own holds. Money only moves inside one database
// transaction with the user row locked, and every movement is a ledger row.

const { pool } = require("../db/db");

class WalletHoldError extends Error {
  constructor(message, status = 400, code = "WALLET_HOLD_ERROR") {
    super(message);
    this.name = "WalletHoldError";
    this.status = status;
    this.code = code;
  }
}

const MAX_HOLD_NAIRA = 5_000_000;
const DEFAULT_TTL_MINUTES = 360;
const MAX_TTL_MINUTES = 1440;

function wholeNaira(value, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0 || n > MAX_HOLD_NAIRA) {
    throw new WalletHoldError(`${label} must be a whole naira amount above 0.`, 400, "BAD_AMOUNT");
  }
  return n;
}

function cleanKey(value, label) {
  const s = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z0-9._:-]{8,120}$/.test(s)) {
    throw new WalletHoldError(`${label} must be 8 to 120 letters, digits or . _ : -`, 400, "BAD_KEY");
  }
  return s;
}

function shape(row, balanceNaira) {
  const out = {
    holdId: row.id,
    service: row.service,
    externalRef: row.external_ref,
    status: row.status,
    amountNaira: Number(row.amount_naira),
    capturedNaira: row.captured_amount_naira == null ? null : Number(row.captured_amount_naira),
    expiresAt: row.expires_at,
  };
  if (balanceNaira != null) out.balanceNaira = Number(balanceNaira);
  return out;
}

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

async function lockUser(client, userId) {
  const r = await client.query("SELECT id, wallet_balance_naira FROM users WHERE id = $1 FOR UPDATE", [userId]);
  return r.rows[0] || null;
}

async function credit(client, { userId, amount, type, description, service }) {
  const u = await client.query(
    "UPDATE users SET wallet_balance_naira = wallet_balance_naira + $1 WHERE id = $2 RETURNING wallet_balance_naira",
    [amount, userId]
  );
  const balance = Number(u.rows[0].wallet_balance_naira);
  const tx = await client.query(
    `INSERT INTO wallet_transactions (user_id, type, status, amount_naira, balance_after_naira, description, service)
     VALUES ($1, $2, 'completed', $3, $4, $5, $6) RETURNING id`,
    [userId, type, amount, balance, description, service]
  );
  return { balance, transactionId: tx.rows[0].id };
}

// Finds a verified rider by email. Only a verified address resolves, so nobody
// can attach a wallet to an account by typing someone else's email.
async function resolveRider(email) {
  const e = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (!e || e.length > 254 || !e.includes("@")) throw new WalletHoldError("A valid email is required.", 400, "BAD_EMAIL");
  const r = await pool.query(
    "SELECT id, name, wallet_balance_naira, email_verified FROM users WHERE lower(email) = $1 LIMIT 1",
    [e]
  );
  const u = r.rows[0];
  if (!u) throw new WalletHoldError("No RideArrivo account for that email.", 404, "NO_ACCOUNT");
  if (!u.email_verified) throw new WalletHoldError("That RideArrivo email is not verified yet.", 409, "EMAIL_NOT_VERIFIED");
  return { userId: u.id, name: u.name, balanceNaira: Number(u.wallet_balance_naira) };
}

async function findExisting(client, service, idempotencyKey, externalRef) {
  const r = await client.query(
    "SELECT * FROM wallet_holds WHERE service = $1 AND (idempotency_key = $2 OR external_ref = $3) FOR UPDATE",
    [service, idempotencyKey, externalRef]
  );
  return r.rows;
}

function sameRequest(row, userId, amount, idempotencyKey) {
  return row.user_id === userId && Number(row.amount_naira) === amount && row.idempotency_key === idempotencyKey;
}

async function placeHold({ service, userId, amountNaira, idempotencyKey, externalRef, ttlMinutes }) {
  const amount = wholeNaira(amountNaira, "amountNaira");
  const key = cleanKey(idempotencyKey, "idempotencyKey");
  const ref = cleanKey(externalRef, "externalRef");
  const ttl = Math.min(Math.max(Math.floor(Number(ttlMinutes)) || DEFAULT_TTL_MINUTES, 5), MAX_TTL_MINUTES);
  if (!Number.isInteger(userId)) throw new WalletHoldError("A rider is required.", 400, "BAD_USER");

  try {
    return await inTransaction(async (client) => {
      const user = await lockUser(client, userId);
      if (!user) throw new WalletHoldError("Rider not found.", 404, "NO_ACCOUNT");

      const existing = await findExisting(client, service, key, ref);
      if (existing.length) {
        const same = existing.find((row) => sameRequest(row, userId, amount, key) && row.external_ref === ref);
        // A retry of the very same request returns what happened the first time.
        if (same) return { ...shape(same, user.wallet_balance_naira), replay: true };
        throw new WalletHoldError("That key or trip reference was already used for a different hold.", 409, "KEY_CONFLICT");
      }

      if (Number(user.wallet_balance_naira) < amount) {
        throw new WalletHoldError("Wallet balance is too low for this trip.", 402, "INSUFFICIENT_BALANCE");
      }

      const debit = await client.query(
        "UPDATE users SET wallet_balance_naira = wallet_balance_naira - $1 WHERE id = $2 RETURNING wallet_balance_naira",
        [amount, userId]
      );
      const balance = Number(debit.rows[0].wallet_balance_naira);
      const tx = await client.query(
        `INSERT INTO wallet_transactions (user_id, type, status, amount_naira, balance_after_naira, description, service)
         VALUES ($1, 'hold', 'completed', $2, $3, $4, $5) RETURNING id`,
        [userId, -amount, balance, `Held for ${service} trip`, service]
      );
      const hold = await client.query(
        `INSERT INTO wallet_holds (user_id, service, amount_naira, idempotency_key, external_ref, hold_transaction_id, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, now() + ($7 || ' minutes')::interval) RETURNING *`,
        [userId, service, amount, key, ref, tx.rows[0].id, String(ttl)]
      );
      return { ...shape(hold.rows[0], balance), replay: false };
    });
  } catch (error) {
    // Two identical requests at the same instant: the loser lands here, and the
    // winner's hold is what it should return.
    if (error.code === "23505") {
      return inTransaction(async (client) => {
        const rows = await findExisting(client, service, key, ref);
        const same = rows.find((row) => sameRequest(row, userId, amount, key) && row.external_ref === ref);
        if (same) return { ...shape(same, null), replay: true };
        throw new WalletHoldError("That key or trip reference was already used for a different hold.", 409, "KEY_CONFLICT");
      });
    }
    throw error;
  }
}

async function lockHold(client, service, externalRef) {
  const ref = cleanKey(externalRef, "externalRef");
  const r = await client.query("SELECT * FROM wallet_holds WHERE service = $1 AND external_ref = $2 FOR UPDATE", [service, ref]);
  if (!r.rows[0]) throw new WalletHoldError("No such hold for this service.", 404, "NO_HOLD");
  return r.rows[0];
}

async function capture({ service, externalRef, amountNaira }) {
  return inTransaction(async (client) => {
    const hold = await lockHold(client, service, externalRef);
    const held = Number(hold.amount_naira);
    const user = await lockUser(client, hold.user_id);
    if (hold.status === "captured") return { ...shape(hold, user.wallet_balance_naira), replay: true };
    if (hold.status === "released") throw new WalletHoldError("That hold was already released.", 409, "ALREADY_RELEASED");

    let final = held;
    if (amountNaira !== undefined && amountNaira !== null) {
      final = Number(amountNaira);
      if (!Number.isInteger(final) || final < 0 || final > held) {
        throw new WalletHoldError("The charge cannot be more than the amount held.", 400, "BAD_AMOUNT");
      }
    }

    let balance = Number(user.wallet_balance_naira);
    if (final < held) {
      const back = await credit(client, {
        userId: hold.user_id,
        amount: held - final,
        type: "hold_refund",
        description: `Unused part of ${service} hold returned`,
        service,
      });
      balance = back.balance;
    }
    const upd = await client.query(
      `UPDATE wallet_holds SET status = 'captured', captured_amount_naira = $1, captured_at = now()
        WHERE id = $2 RETURNING *`,
      [final, hold.id]
    );
    return { ...shape(upd.rows[0], balance), replay: false };
  });
}

async function releaseWithin(client, hold, reason) {
  const back = await credit(client, {
    userId: hold.user_id,
    amount: Number(hold.amount_naira),
    type: "hold_release",
    description: reason,
    service: hold.service,
  });
  const upd = await client.query(
    `UPDATE wallet_holds SET status = 'released', released_at = now(), release_transaction_id = $1
      WHERE id = $2 RETURNING *`,
    [back.transactionId, hold.id]
  );
  return shape(upd.rows[0], back.balance);
}

async function release({ service, externalRef }) {
  return inTransaction(async (client) => {
    const hold = await lockHold(client, service, externalRef);
    const user = await lockUser(client, hold.user_id);
    if (hold.status === "released") return { ...shape(hold, user.wallet_balance_naira), replay: true };
    if (hold.status === "captured") throw new WalletHoldError("That hold was already charged.", 409, "ALREADY_CAPTURED");
    return { ...(await releaseWithin(client, hold, `${hold.service} trip cancelled, money returned`)), replay: false };
  });
}

async function getHold({ service, externalRef }) {
  const ref = cleanKey(externalRef, "externalRef");
  const r = await pool.query("SELECT * FROM wallet_holds WHERE service = $1 AND external_ref = $2", [service, ref]);
  if (!r.rows[0]) throw new WalletHoldError("No such hold for this service.", 404, "NO_HOLD");
  return shape(r.rows[0], null);
}

// Releases holds still open past their expiry. SKIP LOCKED lets two instances
// sweep side by side without waiting on each other.
async function expireStale(limit = 100) {
  let released = 0;
  const ids = (await pool.query(
    "SELECT id FROM wallet_holds WHERE status = 'held' AND expires_at < now() ORDER BY expires_at LIMIT $1",
    [limit]
  )).rows;
  for (const { id } of ids) {
    await inTransaction(async (client) => {
      const r = await client.query(
        "SELECT * FROM wallet_holds WHERE id = $1 AND status = 'held' AND expires_at < now() FOR UPDATE SKIP LOCKED",
        [id]
      );
      if (!r.rows[0]) return;
      await lockUser(client, r.rows[0].user_id);
      await releaseWithin(client, r.rows[0], `${r.rows[0].service} hold expired, money returned`);
      released += 1;
    });
  }
  return released;
}

module.exports = { WalletHoldError, resolveRider, placeHold, capture, release, getHold, expireStale };
