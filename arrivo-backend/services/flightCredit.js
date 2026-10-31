// PArAsYtE | RideArrivo backend
//
// A cancelled arrival flight: keep the money for a future booking.
//
// Decision (Biola, 31 Oct 2026): when the flight a rider booked an airport pickup for is cancelled,
// the fare is not refunded to the card. It is kept as wallet credit for their next booking, the ride
// is cancelled so no driver is sent, and Ops see the case with who it belongs to.
//
// This moves money, so it is OFF unless FLIGHT_CANCEL_CREDIT=on. With it off nothing here writes.
// The legal wording (terms, consumer refund rights) is for counsel before it is switched on in
// production. Staging first.
//
// What catches a cancellation:
//   1. The sweep in services/scheduler.js: provider says the flight is cancelled.
//   2. Ops, by hand: the provider is wrong or silent but the airline has cancelled. Ops search the
//      credit queue by rider name, passenger surname, email, phone, flight number or ride number.
//   3. Ops can move a held credit to another account when the booking was made under someone else's
//      account (a PA, a relative, a colleague). Both sides are written to the wallet ledger.

// Loaded on first use so the pure helpers (and their tests) never open a database connection.
const realDb = () => require("../db/db").pool;

const STATUSES_THAT_CAN_BE_CREDITED = ["requested", "accepted"];

function creditEnabled(env = process.env) {
  return String(env.FLIGHT_CANCEL_CREDIT || "").toLowerCase() === "on";
}

// Names are compared without case, accents or extra spaces, so "Nasr", "NASR" and " nasr " match,
// and "Hélène" matches "Helene". Arabic and Turkish names are kept as they are, only trimmed and
// lower-cased (Turkish dotless i is folded so "ISIK" finds "ışık").
function nameKey(s) {
  return String(s || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ı/g, "i")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

// Every word the searcher typed must start a word in the candidate, in any order.
function nameMatches(query, candidate) {
  const q = nameKey(query).split(" ").filter(Boolean);
  if (!q.length) return false;
  const words = nameKey(candidate).split(" ").filter(Boolean);
  return q.every((w) => words.some((c) => c.startsWith(w)));
}

// Pure. Says what should happen for a ride given what the flight lookup returned.
function decideCredit(ride, looked, env = process.env) {
  if (!ride || !looked) return { action: "none", why: "missing" };
  if (ride.booking_type !== "one_way") return { action: "none", why: "not_arrival" };
  if (looked.state !== "cancelled") return { action: "none", why: "not_cancelled" };
  if (!STATUSES_THAT_CAN_BE_CREDITED.includes(ride.ride_status)) return { action: "none", why: "ride_not_open" };
  if (!creditEnabled(env)) return { action: "none", why: "switched_off" };
  if (ride.payment_status === "paid") return { action: "credit", amount: Number(ride.fare_naira) };
  // Pay-later rides have taken no money, so there is nothing to keep. The ride is closed so no
  // driver is sent for a flight that is not coming.
  return { action: "close", amount: 0 };
}

function creditMessage(ride, amount) {
  const money = `₦${Math.round(amount).toLocaleString("en-NG")}`;
  return amount > 0
    ? `Your flight ${ride.flight_number} was cancelled, so we cancelled your airport pickup. We are keeping ${money} in your RideArrivo wallet for your next booking. If your plans changed, contact support and we will help.`
    : `Your flight ${ride.flight_number} was cancelled, so we cancelled your airport pickup. Nothing was charged. Book again when you have a new flight.`;
}

// Writes everything in one transaction. Safe to call twice: the unique ride_id and the status
// re-check under lock mean the money is only ever moved once.
async function applyCredit(rideId, { actorId = null, source = "scheduler", env = process.env, db = null } = {}) {
  if (!creditEnabled(env)) return { done: false, why: "switched_off" };
  db = db || realDb();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const r = await client.query("SELECT * FROM rides WHERE id = $1 FOR UPDATE", [rideId]);
    const ride = r.rows[0];
    if (!ride) { await client.query("ROLLBACK"); return { done: false, why: "not_found" }; }
    if (ride.booking_type !== "one_way") { await client.query("ROLLBACK"); return { done: false, why: "not_arrival" }; }
    if (!STATUSES_THAT_CAN_BE_CREDITED.includes(ride.ride_status)) { await client.query("ROLLBACK"); return { done: false, why: "ride_not_open" }; }

    let amount = 0;
    let creditId = null;
    if (ride.payment_status === "paid" && Number(ride.fare_naira) > 0) {
      amount = Number(ride.fare_naira);
      const ins = await client.query(
        `INSERT INTO flight_credits (ride_id, user_id, amount_naira, flight_number, flight_date, passenger_surname, created_by, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (ride_id) DO NOTHING RETURNING id`,
        [ride.id, ride.rider_id, amount, ride.flight_number, ride.flight_date, ride.passenger_surname || null, actorId, source]
      );
      if (!ins.rows.length) { await client.query("ROLLBACK"); return { done: false, why: "already_credited" }; }
      creditId = ins.rows[0].id;
      const bal = await client.query(
        "UPDATE users SET wallet_balance_naira = wallet_balance_naira + $1 WHERE id = $2 RETURNING wallet_balance_naira",
        [amount, ride.rider_id]
      );
      const tx = await client.query(
        `INSERT INTO wallet_transactions (user_id, type, status, amount_naira, balance_after_naira, ride_id, description)
         VALUES ($1, 'flight_credit', 'completed', $2, $3, $4, $5) RETURNING id`,
        [ride.rider_id, amount, Number(bal.rows[0].wallet_balance_naira), ride.id, `Credit kept: flight ${ride.flight_number} cancelled, Ride #${ride.id}`]
      );
      await client.query("UPDATE flight_credits SET wallet_transaction_id = $2 WHERE id = $1", [creditId, tx.rows[0].id]);
      await client.query(
        "INSERT INTO flight_credit_events (credit_id, actor_id, action, detail) VALUES ($1, $2, 'created', $3)",
        [creditId, actorId, JSON.stringify({ source, amount, ride_id: ride.id })]
      );
    }
    await client.query(
      `UPDATE rides SET ride_status = 'cancelled', flight_issue = 'cancelled', flight_issue_notified_at = now(),
              payment_status = $2, updated_at = now() WHERE id = $1`,
      [ride.id, amount > 0 ? "credited" : ride.payment_status]
    );
    await client.query("COMMIT");
    return { done: true, amount, creditId, ride };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Ops queue. q matches rider name, passenger surname, email, phone, flight number or ride number.
// Words are ANDed, so "nasr beirut" narrows rather than widens.
async function searchCredits({ q = "", status = null, limit = 50, db = null } = {}) {
  const words = nameKey(q).split(" ").filter(Boolean).slice(0, 5);
  const params = [];
  const where = [];
  for (const w of words) {
    params.push(`%${w}%`);
    const like = `$${params.length}`;
    params.push(w);
    const bare = `$${params.length}`;
    where.push(`(lower(u.name) LIKE ${like} OR lower(coalesce(fc.passenger_surname,'')) LIKE ${like} OR lower(u.email) LIKE ${like}
                 OR coalesce(u.phone,'') LIKE ${like} OR lower(coalesce(fc.flight_number,'')) LIKE ${like} OR fc.ride_id::text = ${bare})`);
  }
  if (status) { params.push(status); where.push(`fc.status = $${params.length}`); }
  const cap = Math.max(1, Math.min(200, Number(limit) || 50));
  db = db || realDb();
  const res = await db.query(
    `SELECT fc.*, u.name AS rider_name, u.email AS rider_email, u.phone AS rider_phone,
            u.wallet_balance_naira AS rider_wallet_naira, to_char(fc.flight_date,'YYYY-MM-DD') AS flight_date_str
     FROM flight_credits fc JOIN users u ON u.id = fc.user_id
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY fc.created_at DESC LIMIT ${cap}`,
    params
  );
  return res.rows;
}

// Move a held credit to another account. Refuses if the rider has already spent it, so the ledger
// never goes negative and Ops see a clear reason.
async function moveCredit(creditId, toUserId, { actorId, note = "", db = null } = {}) {
  db = db || realDb();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const c = await client.query("SELECT * FROM flight_credits WHERE id = $1 FOR UPDATE", [creditId]);
    const credit = c.rows[0];
    if (!credit) { await client.query("ROLLBACK"); return { done: false, why: "not_found" }; }
    if (credit.status !== "held") { await client.query("ROLLBACK"); return { done: false, why: "not_held" }; }
    if (Number(toUserId) === Number(credit.user_id)) { await client.query("ROLLBACK"); return { done: false, why: "same_account" }; }
    const target = await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [toUserId]);
    if (!target.rows.length) { await client.query("ROLLBACK"); return { done: false, why: "target_not_found" }; }
    const amount = Number(credit.amount_naira);
    const from = await client.query("UPDATE users SET wallet_balance_naira = wallet_balance_naira - $1 WHERE id = $2 AND wallet_balance_naira >= $1 RETURNING wallet_balance_naira", [amount, credit.user_id]);
    if (!from.rows.length) { await client.query("ROLLBACK"); return { done: false, why: "already_spent" }; }
    await client.query(
      `INSERT INTO wallet_transactions (user_id, type, status, amount_naira, balance_after_naira, ride_id, description)
       VALUES ($1, 'flight_credit_transfer', 'completed', $2, $3, $4, $5)`,
      [credit.user_id, -amount, Number(from.rows[0].wallet_balance_naira), credit.ride_id, `Credit moved to another account by support, Ride #${credit.ride_id}`]
    );
    const to = await client.query("UPDATE users SET wallet_balance_naira = wallet_balance_naira + $1 WHERE id = $2 RETURNING wallet_balance_naira", [amount, toUserId]);
    await client.query(
      `INSERT INTO wallet_transactions (user_id, type, status, amount_naira, balance_after_naira, ride_id, description)
       VALUES ($1, 'flight_credit_transfer', 'completed', $2, $3, $4, $5)`,
      [toUserId, amount, Number(to.rows[0].wallet_balance_naira), credit.ride_id, `Credit received from a cancelled flight, Ride #${credit.ride_id}`]
    );
    await client.query("UPDATE flight_credits SET status = 'moved', moved_to_user_id = $2, updated_at = now() WHERE id = $1", [creditId, toUserId]);
    await client.query("INSERT INTO flight_credit_events (credit_id, actor_id, action, detail) VALUES ($1, $2, 'moved', $3)", [creditId, actorId || null, JSON.stringify({ to_user_id: Number(toUserId), amount, note: String(note).slice(0, 300) })]);
    await client.query("COMMIT");
    return { done: true, amount };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { creditEnabled, nameKey, nameMatches, decideCredit, creditMessage, applyCredit, searchCredits, moveCredit };
