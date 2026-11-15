// Run: DATABASE_URL=... node routes/assistedBookingRide.integration.test.js
// A paid support-assisted or public-form booking has to become a ride. It
// didn't: the insert passed null into promo_discount_naira, which is NOT NULL,
// so the rider was charged and no ride was made.
const assert = require("assert");
const { pool, ready } = require("../db/db");
const { createRideFromAssistedBooking } = require("./payments");

const stamp = Date.now();
(async () => {
  let userId = null;
  try {
await ready;
    userId = (await pool.query(
      `INSERT INTO users (name, email, password_hash, role, agreed_to_terms, email_verified)
       VALUES ('Assisted ride', $1, 'x', 'rider', true, true) RETURNING id`,
      [`assisted-ride-${stamp}@example.com`]
    )).rows[0].id;
    const client = await pool.connect();
    let ride;
    try {
      await client.query("BEGIN");
      ride = await createRideFromAssistedBooking(client, {
        rider_id: userId, quoted_usd_amount: 30, quoted_ngn_per_usd: 1500,
        booking_request: {
          bookingType: "one_way", vehicleType: "sedan", durationDays: 1, passengerCount: 1, adults: 1, children: 0,
          pickupAddress: "Murtala Muhammed International Airport, Ikeja, Lagos", destinationAddress: "Victoria Island, Lagos",
        },
      }, `T_assisted_${stamp}`, 45000);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally { client.release(); }
    assert.ok(ride && ride.id, "a ride was made");
    assert.strictEqual(ride.payment_status, "paid");
    assert.strictEqual(Number(ride.promo_discount_naira), 0);
    console.log("  ok  a paid assisted booking becomes a paid ride");
  } catch (e) {
    console.log("FAIL  a paid assisted booking becomes a paid ride\n      " + (e.stack || e.message));
    process.exitCode = 1;
  } finally {
    if (userId) {
      await pool.query("DELETE FROM ride_team_events WHERE ride_id IN (SELECT id FROM rides WHERE rider_id = $1)", [userId]).catch(() => {});
      await pool.query("DELETE FROM ride_team WHERE ride_id IN (SELECT id FROM rides WHERE rider_id = $1)", [userId]).catch(() => {});
      await pool.query("DELETE FROM rides WHERE rider_id = $1", [userId]).catch(() => {});
      await pool.query("DELETE FROM users WHERE id = $1", [userId]).catch(() => {});
    }
    await pool.end();
  }
})();
