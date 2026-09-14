const { pool } = require("../db/db");
const {
  getInstantDispatchConfig,
} = require("./instantDispatch");
const {
  refundRequestWithinTransaction,
} = require("./instantWallet");

function withParsedStops(ride) {
  if (!ride) return ride;

  let stops = [];

  try {
    stops = JSON.parse(ride.stops || "[]");
  } catch {
    stops = [];
  }

  return {
    ...ride,
    stops,
  };
}

async function requeueIfNoLiveOffers(
  client,
  requestId
) {
  const liveResult = await client.query(
    `SELECT 1
       FROM instant_ride_offers
      WHERE request_id = $1
        AND status = 'offered'
        AND expires_at > now()
      LIMIT 1`,
    [requestId]
  );

  if (!liveResult.rows.length) {
    await client.query(
      `UPDATE instant_ride_requests
          SET status = CASE
                WHEN expires_at <= now()
                  THEN status
                ELSE 'searching'
              END,
              updated_at = now()
        WHERE id = $1
          AND status = 'offering'
          AND matched_driver_id IS NULL
          AND ride_id IS NULL`,
      [requestId]
    );
  }
}

async function loseOffer(
  client,
  requestId,
  offerId
) {
  await client.query(
    `UPDATE instant_ride_offers
        SET status = 'lost',
            responded_at =
              COALESCE(responded_at, now())
      WHERE id = $1
        AND status = 'offered'`,
    [offerId]
  );

  await requeueIfNoLiveOffers(
    client,
    requestId
  );
}

async function fetchCanonicalRide(
  client,
  rideId
) {
  const result = await client.query(
    `SELECT *
       FROM rides
      WHERE id = $1`,
    [rideId]
  );

  return result.rows[0] || null;
}

async function acceptInstantOffer({
  driverId,
  offerId,
}) {
  if (
    !Number.isInteger(Number(driverId))
    || Number(driverId) <= 0
  ) {
    return {
      status: "driver_not_found",
    };
  }

  if (
    !Number.isInteger(Number(offerId))
    || Number(offerId) <= 0
    || Number(offerId) > 2147483647
  ) {
    return {
      status: "not_found",
    };
  }

  const normalizedDriverId =
    Number(driverId);

  const normalizedOfferId =
    Number(offerId);

  const config =
    getInstantDispatchConfig();

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // First read only enough to discover the request. We deliberately do
    // not lock the offer first: expiry/refund locks the request first, so
    // using the same lock order avoids request<->offer deadlocks.
    const pointerResult = await client.query(
      `SELECT request_id
         FROM instant_ride_offers
        WHERE id = $1
          AND driver_id = $2`,
      [
        normalizedOfferId,
        normalizedDriverId,
      ]
    );

    if (!pointerResult.rows[0]) {
      await client.query("ROLLBACK");

      return {
        status: "not_found",
      };
    }

    const requestId =
      pointerResult.rows[0].request_id;

    // The request is the winner-selection lock. Every driver attempting
    // to accept an offer for this request must serialize here.
    const requestResult = await client.query(
      `SELECT *
         FROM instant_ride_requests
        WHERE id = $1
        FOR UPDATE`,
      [requestId]
    );

    const request =
      requestResult.rows[0];

    if (!request) {
      await client.query("ROLLBACK");

      return {
        status: "not_found",
      };
    }

    const offerResult = await client.query(
      `SELECT *
         FROM instant_ride_offers
        WHERE id = $1
          AND driver_id = $2
        FOR UPDATE`,
      [
        normalizedOfferId,
        normalizedDriverId,
      ]
    );

    const offer =
      offerResult.rows[0];

    if (!offer) {
      await client.query("ROLLBACK");

      return {
        status: "not_found",
      };
    }

    // Safe idempotency for a driver's retry after a timeout/network loss.
    if (
      request.status === "matched"
      && Number(request.matched_driver_id)
        === normalizedDriverId
      && request.ride_id
      && offer.status === "accepted"
    ) {
      const ride =
        await fetchCanonicalRide(
          client,
          request.ride_id
        );

      await client.query("COMMIT");

      return {
        status: "accepted",
        alreadyAccepted: true,
        requestId: request.id,
        offerId: offer.id,
        ride: withParsedStops(ride),
      };
    }

    if (
      request.status === "matched"
      || request.matched_driver_id
      || request.ride_id
    ) {
      await client.query("ROLLBACK");

      return {
        status: "already_matched",
        requestId: request.id,
        rideId: request.ride_id || null,
      };
    }

    if (
      request.status === "cancelled"
      || request.status === "expired"
    ) {
      await client.query("ROLLBACK");

      return {
        status: request.status,
        requestId: request.id,
      };
    }

    if (
      new Date(request.expires_at).getTime()
        <= Date.now()
    ) {
      const refund =
        await refundRequestWithinTransaction(
          client,
          request,
          "expired",
          "driver attempted acceptance after the ArrivoNow request expired"
        );

      await client.query("COMMIT");

      return {
        status: "expired",
        requestId: request.id,
        refunded: refund.refunded,
        balanceNaira:
          refund.balanceNaira,
      };
    }

    if (
      offer.status !== "offered"
    ) {
      await client.query("ROLLBACK");

      return {
        status: "offer_inactive",
        offerStatus: offer.status,
        requestId: request.id,
      };
    }

    if (
      new Date(offer.expires_at).getTime()
        <= Date.now()
    ) {
      await client.query(
        `UPDATE instant_ride_offers
            SET status = 'expired',
                responded_at =
                  COALESCE(responded_at, now())
          WHERE id = $1`,
        [offer.id]
      );

      await requeueIfNoLiveOffers(
        client,
        request.id
      );

      await client.query("COMMIT");

      return {
        status: "offer_expired",
        requestId: request.id,
        offerId: offer.id,
      };
    }

    // Serialize competing ArrivoNow accept attempts by this same driver.
    const driverResult = await client.query(
      `SELECT
         d.id,
         d.user_id,
         d.vehicle_id,
         d.is_verified,
         d.is_online,
         d.accepts_instant,
         d.location_updated_at,
         v.vehicle_type
       FROM drivers d
       LEFT JOIN vehicles v
         ON v.id = d.vehicle_id
       WHERE d.id = $1
       FOR UPDATE OF d`,
      [normalizedDriverId]
    );

    const driver =
      driverResult.rows[0];

    if (!driver) {
      await loseOffer(
        client,
        request.id,
        offer.id
      );

      await client.query("COMMIT");

      return {
        status: "driver_not_found",
      };
    }

    const locationTime =
      driver.location_updated_at
        ? new Date(
            driver.location_updated_at
          ).getTime()
        : NaN;

    const locationFresh =
      Number.isFinite(locationTime)
      && locationTime
        >= Date.now()
          - (
            config.locationMaxAgeSeconds
            * 1000
          );

    const vehicleCompatible =
      !request.vehicle_type
      || driver.vehicle_type
        === request.vehicle_type;

    if (
      !driver.is_verified
      || !driver.is_online
      || !driver.accepts_instant
      || !locationFresh
      || !vehicleCompatible
    ) {
      await loseOffer(
        client,
        request.id,
        offer.id
      );

      await client.query("COMMIT");

      return {
        status: "driver_ineligible",
        requestId: request.id,
        offerId: offer.id,
      };
    }

    const activeRideResult =
      await client.query(
        `SELECT id
           FROM rides
          WHERE driver_id = $1
            AND ride_status IN (
              'accepted',
              'in_progress'
            )
          ORDER BY id
          LIMIT 1
          FOR UPDATE`,
        [normalizedDriverId]
      );

    if (activeRideResult.rows[0]) {
      await loseOffer(
        client,
        request.id,
        offer.id
      );

      await client.query("COMMIT");

      return {
        status: "driver_busy",
        requestId: request.id,
        rideId:
          activeRideResult.rows[0].id,
      };
    }

    // No canonical ride is created unless the ArrivoNow payment is still
    // secured. Card is intentionally not enabled in this rollout yet.
    if (
      request.payment_method !== "wallet"
      || request.payment_status !== "paid"
      || !request.wallet_transaction_id
      || request.refund_wallet_transaction_id
      || request.refunded_at
    ) {
      await client.query("ROLLBACK");

      return {
        status: "payment_not_secured",
        requestId: request.id,
      };
    }

    const fareNaira =
      Number(
        request.estimated_fare_naira
      );

    if (
      !Number.isInteger(fareNaira)
      || fareNaira <= 0
    ) {
      await client.query("ROLLBACK");

      return {
        status: "payment_not_secured",
        requestId: request.id,
      };
    }

    // Lock the original wallet debit before attaching it to the ride.
    const walletResult =
      await client.query(
        `SELECT *
           FROM wallet_transactions
          WHERE id = $1
            AND user_id = $2
          FOR UPDATE`,
        [
          request.wallet_transaction_id,
          request.rider_id,
        ]
      );

    const walletTransaction =
      walletResult.rows[0];

    if (
      !walletTransaction
      || walletTransaction.type
        !== "ride_charge"
      || walletTransaction.status
        !== "completed"
      || walletTransaction.ride_id
        !== null
      || Number(
        walletTransaction.amount_naira
      ) !== -fareNaira
    ) {
      await client.query("ROLLBACK");

      return {
        status: "payment_not_secured",
        requestId: request.id,
      };
    }

    // RideArrivo's existing screens treat stops as an array of address
    // strings and the last element as the final destination.
    const stops = JSON.stringify([
      request.destination_address,
    ]);

    const rideResult =
      await client.query(
        `INSERT INTO rides (
           rider_id,
           driver_id,
           pickup_address,
           stops,
           vehicle_type,
           booking_type,
           duration_days,
           fare_naira,
           payment_status,
           ride_status,
           agreed_cancellation_policy,
           distance_km,
           duration_min,
           payment_method,
           pay_at_pickup,
           pickup_lat,
           pickup_lng,
           destination_lat,
           destination_lng,
           service_mode
         )
         VALUES (
           $1,
           $2,
           $3,
           $4,
           $5,
           'one_way',
           1,
           $6,
           'paid',
           'accepted',
           true,
           $7,
           $8,
           'wallet',
           false,
           $9,
           $10,
           $11,
           $12,
           'instant'
         )
         RETURNING *`,
        [
          request.rider_id,
          normalizedDriverId,
          request.pickup_address,
          stops,
          request.vehicle_type,
          fareNaira,
          request.estimated_distance_km,
          request.estimated_duration_min,
          request.pickup_lat,
          request.pickup_lng,
          request.destination_lat,
          request.destination_lng,
        ]
      );

    const ride =
      rideResult.rows[0];

    const walletAttachResult =
      await client.query(
        `UPDATE wallet_transactions
            SET ride_id = $1,
                description = $2
          WHERE id = $3
            AND user_id = $4
            AND ride_id IS NULL
          RETURNING id`,
        [
          ride.id,
          `ArrivoNow Ride #${ride.id} (${request.pickup_address})`,
          request.wallet_transaction_id,
          request.rider_id,
        ]
      );

    if (
      walletAttachResult.rowCount !== 1
    ) {
      throw new Error(
        "ArrivoNow wallet charge could not be attached to the canonical ride."
      );
    }

    const matchedRequestResult =
      await client.query(
        `UPDATE instant_ride_requests
            SET status = 'matched',
                matched_driver_id = $1,
                ride_id = $2,
                matched_at = now(),
                updated_at = now()
          WHERE id = $3
            AND status IN (
              'searching',
              'offering'
            )
            AND matched_driver_id IS NULL
            AND ride_id IS NULL
          RETURNING *`,
        [
          normalizedDriverId,
          ride.id,
          request.id,
        ]
      );

    if (
      matchedRequestResult.rowCount !== 1
    ) {
      throw new Error(
        "ArrivoNow request could not be atomically matched."
      );
    }

    const winningOfferResult =
      await client.query(
        `UPDATE instant_ride_offers
            SET status = 'accepted',
                responded_at = now()
          WHERE id = $1
            AND request_id = $2
            AND driver_id = $3
            AND status = 'offered'
          RETURNING *`,
        [
          offer.id,
          request.id,
          normalizedDriverId,
        ]
      );

    if (
      winningOfferResult.rowCount !== 1
    ) {
      throw new Error(
        "ArrivoNow winning offer could not be atomically accepted."
      );
    }

    await client.query(
      `UPDATE instant_ride_offers
          SET status = 'lost',
              responded_at =
                COALESCE(responded_at, now())
        WHERE request_id = $1
          AND id <> $2
          AND status = 'offered'`,
      [
        request.id,
        offer.id,
      ]
    );

    await client.query("COMMIT");

    return {
      status: "accepted",
      alreadyAccepted: false,
      requestId: request.id,
      offerId: offer.id,
      ride: withParsedStops(ride),
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  acceptInstantOffer,
};
