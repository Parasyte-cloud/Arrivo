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
// The exception is emergency_contacts. Those rows hold a third party's name and
// phone, someone who never had an account and never agreed to anything, so
// there is no reason to keep them and they are deleted outright.

const crypto = require("crypto");

// A trip that has not finished or been called off. Deleting mid-trip would
// strip the driver's contact details while somebody is still in the car.
const ACTIVE_RIDE_STATUSES = ["requested", "accepted", "in_progress"];

const BLOCKED_ACTIVE_RIDE = "active_ride";
const BLOCKED_WALLET_BALANCE = "wallet_balance";

// Why the account cannot go yet, or null if it can. Checked before anything is
// written, so a refusal leaves the account exactly as it was.
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

  // Money on the account is the rider's, and deleting is not the same as
  // agreeing to forfeit it. Make them empty it first rather than quietly
  // keeping the balance.
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

// Frees the real address so somebody can sign up again with it, while keeping
// the UNIQUE constraint on email satisfied. .invalid can never be a real
// domain, which is the point of it (RFC 2606).
function tombstoneEmail(userId) {
  return `deleted+${userId}@deleted.invalid`;
}

async function anonymiseAccount(pool, userId) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Someone else's details, kept only so we could call them for this rider.
    // Nothing to anonymise, they just go.
    await client.query("DELETE FROM emergency_contacts WHERE user_id = $1", [userId]);

    // A driver row carries its own documents and last known position.
    await client.query(
      `UPDATE drivers
          SET license_number = NULL,
              lasdri_number = NULL,
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
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  ACTIVE_RIDE_STATUSES,
  BLOCKED_ACTIVE_RIDE,
  BLOCKED_WALLET_BALANCE,
  findDeletionBlocker,
  anonymiseAccount,
  tombstoneEmail,
};
