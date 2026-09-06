// Deleting an account, as required by the NDPA rights section of the privacy
// policy and by both app stores, which will not approve an app that lets you
// sign up but not leave.
//
// This anonymises rather than DELETEs. Nine tables reference users(id) with no
// ON DELETE clause, so Postgres would refuse a real delete outright, and the
// retention policy says transactional records live for seven years for tax and
// dispute reasons. Both point the same way: keep the row, strip the person out
// of it.
//
// ── What survives, and why ──────────────────────────────────────────────────
//
// The retention policy justifies keeping "minimal transactional records" for
// statutory tax, accounting and dispute-resolution purposes. That is an invoice,
// not a diary. So a ride keeps what an invoice would carry:
//
//   kept     fare, currency, dates, status, vehicle type, ride id
//   kept     pickup and destination ADDRESSES, since a dispute is usually about
//            whether the trip we billed for is the trip that happened
//   scrubbed precise coordinates, which are finer than any invoice needs
//   scrubbed the rider's free-text rating comment, an opinion with no tax or
//            accounting purpose
//   scrubbed emergency contact name and phone, which belong to a third party
//            who never had an account here
//
// Support ticket subject and body are the rider's own words, so the text goes
// and the shell (type, status, dates) stays, which is what a dispute trail
// actually needs.
//
// On-the-Go requests are not transactions at all until ops turns one into a
// ride, so a pending one is cancelled and scrubbed rather than left sitting in
// an ops queue with a deleted person's phone number and pickup address on it.
//
// emergency_contacts rows are deleted outright. Same reasoning as above: that
// is a third party's name and phone, and there is nothing to anonymise.
//
// These are judgement calls about retention, not legal advice. If the real
// obligation is narrower or wider, this is the one place to change it.

const crypto = require("crypto");

// A trip that has not finished or been called off. Deleting mid-trip would
// strip the driver's contact details while somebody is still in the car.
const ACTIVE_RIDE_STATUSES = ["requested", "accepted", "in_progress"];

const BLOCKED_ACTIVE_RIDE = "active_ride";
const BLOCKED_WALLET_BALANCE = "wallet_balance";

// Postgres raises this when a SERIALIZABLE transaction could not be ordered
// against a concurrent one. Callers should ask the user to try again.
const SERIALIZATION_FAILURE = "40001";

class DeletionBlocked extends Error {
  constructor(reason, message) {
    super(message);
    this.name = "DeletionBlocked";
    this.reason = reason;
  }
}

// Frees the real address so somebody can sign up again with it, while keeping
// the UNIQUE constraint on email satisfied. .invalid can never be a real
// domain, which is the point of it (RFC 2606).
function tombstoneEmail(userId) {
  return `deleted+${userId}@deleted.invalid`;
}

// Read-only pre-check, used to tell the app why the button will not work before
// somebody types their email out. The authoritative check is the one inside the
// transaction below, because anything checked out here can change before the
// write lands.
async function findDeletionBlocker(pool, userId) {
  const active = await pool.query(
    `SELECT rides.id
       FROM rides
       LEFT JOIN drivers ON drivers.id = rides.driver_id
      WHERE (rides.rider_id = $1 OR drivers.user_id = $1)
        AND rides.ride_status = ANY($2)
      LIMIT 1`,
    [userId, ACTIVE_RIDE_STATUSES]
  );

  if (active.rows[0]) {
    return {
      reason: BLOCKED_ACTIVE_RIDE,
      message:
        "You have a trip that hasn't finished yet. Once it's completed or cancelled you can delete your account.",
    };
  }

  const wallet = await pool.query("SELECT wallet_balance_naira FROM users WHERE id = $1", [userId]);
  const balance = Number(wallet.rows[0]?.wallet_balance_naira || 0);

  if (balance > 0) {
    return {
      reason: BLOCKED_WALLET_BALANCE,
      message:
        "There's still money in your wallet. Spend it or contact support to withdraw it, then you can delete your account.",
    };
  }

  return null;
}

// The guards and the scrub run in one SERIALIZABLE transaction, with the user
// row locked. Checking first and writing afterwards left a race: a wallet
// top-up already in flight could commit after a zero-balance check passed, and
// a new ride could be inserted after the active-trip check passed. Locking the
// user row serialises anything that touches the balance, and SERIALIZABLE makes
// Postgres refuse the transaction outright if a concurrent ride insert would
// have changed the answer.
async function anonymiseAccount(pool, userId) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");

    const locked = await client.query(
      "SELECT wallet_balance_naira, deleted_at FROM users WHERE id = $1 FOR UPDATE",
      [userId]
    );
    const account = locked.rows[0];
    if (!account || account.deleted_at) {
      await client.query("ROLLBACK");
      return null;
    }

    // Re-checked here rather than trusted from the pre-check, now that nothing
    // else can move underneath us.
    const active = await client.query(
      `SELECT rides.id
         FROM rides
         LEFT JOIN drivers ON drivers.id = rides.driver_id
        WHERE (rides.rider_id = $1 OR drivers.user_id = $1)
          AND rides.ride_status = ANY($2)
        LIMIT 1`,
      [userId, ACTIVE_RIDE_STATUSES]
    );
    if (active.rows[0]) {
      throw new DeletionBlocked(
        BLOCKED_ACTIVE_RIDE,
        "You have a trip that hasn't finished yet. Once it's completed or cancelled you can delete your account."
      );
    }

    if (Number(account.wallet_balance_naira || 0) > 0) {
      throw new DeletionBlocked(
        BLOCKED_WALLET_BALANCE,
        "There's still money in your wallet. Spend it or contact support to withdraw it, then you can delete your account."
      );
    }

    // Third party details, kept only so we could call them for this person.
    await client.query("DELETE FROM emergency_contacts WHERE user_id = $1", [userId]);

    // A pending On-the-Go request is an ops queue entry holding a phone number,
    // a pickup address and a destination. It is not a transaction, so there is
    // nothing to retain: cancel it and empty it in the same breath.
    await client.query(
      `UPDATE on_the_go_requests
          SET status = CASE WHEN status = 'pending' THEN 'cancelled' ELSE status END,
              pickup_address = 'Removed',
              destination_address = 'Removed',
              flight_number = NULL,
              contact_phone = 'Removed'
        WHERE user_id = $1`,
      [userId]
    );

    // The rider's own words, and a third party's contact details. Neither is an
    // invoice. Addresses and fares stay, see the note at the top.
    await client.query(
      `UPDATE rides
          SET emergency_contact_name = NULL,
              emergency_contact_phone = NULL,
              rider_rating_comment = NULL,
              pickup_lat = NULL,
              pickup_lng = NULL,
              destination_lat = NULL,
              destination_lng = NULL
        WHERE rider_id = $1`,
      [userId]
    );

    // Keep the shell so a dispute still has a trail, drop what they wrote.
    await client.query(
      `UPDATE support_tickets
          SET subject = 'Removed on account deletion',
              description = 'Removed on account deletion'
        WHERE user_id = $1`,
      [userId]
    );

    // Everything a driver hands over: documents, photos, the vehicle owner's
    // details and their own emergency contact, who is another third party.
    await client.query(
      `UPDATE drivers
          SET license_number = NULL,
              lasdri_number = NULL,
              insurance_number = NULL,
              owner_name = NULL,
              owner_whatsapp = NULL,
              profile_photo_url = NULL,
              license_photo_url = NULL,
              vehicle_photo_url = NULL,
              emergency_contact_name = NULL,
              emergency_contact_phone = NULL,
              current_lat = NULL,
              current_lng = NULL,
              location_updated_at = NULL,
              scan_token = NULL,
              is_online = false,
              is_verified = false
        WHERE user_id = $1`,
      [userId]
    );

    // password_hash is NOT NULL, so it gets a value nobody holds rather than
    // being emptied. bcrypt will never match a raw random string.
    const unusablePassword = crypto.randomBytes(32).toString("hex");

    const result = await client.query(
      `UPDATE users
          SET name = 'Deleted user',
              email = $2,
              phone = NULL,
              whatsapp_number = NULL,
              country_of_residence = NULL,
              passport_number = NULL,
              date_of_birth = NULL,
              avatar_url = NULL,
              id_document_url = NULL,
              id_verification_status = 'unverified',
              id_verification_rejection_reason = NULL,
              password_hash = $3,
              google_id = NULL,
              apple_id = NULL,
              apple_refresh_token = NULL,
              push_token = NULL,
              email_verified = false,
              email_verification_token = NULL,
              email_verification_expires = NULL,
              reset_token = NULL,
              reset_token_expires = NULL,
              preferred_vehicle_type = NULL,
              temperature_preference = NULL,
              quiet_ride = false,
              child_seat_required = false,
              traveling_with_pet = false,
              audio_recording_enabled = false,
              deleted_at = now()
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING id, deleted_at`,
      [userId, tombstoneEmail(userId), unusablePassword]
    );

    await client.query("COMMIT");
    return result.rows[0] || null;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  ACTIVE_RIDE_STATUSES,
  BLOCKED_ACTIVE_RIDE,
  BLOCKED_WALLET_BALANCE,
  SERIALIZATION_FAILURE,
  DeletionBlocked,
  findDeletionBlocker,
  anonymiseAccount,
  tombstoneEmail,
};
