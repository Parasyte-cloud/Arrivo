const {
  pool,
} = require("../db/db");

class InstantWalletError extends Error {
  constructor(message, status = 400, code = "INSTANT_WALLET_ERROR", details = {}) {
    super(message);
    this.name = "InstantWalletError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function positiveFare(value) {
  const fare = Number(value);

  if (!Number.isInteger(fare) || fare <= 0) {
    throw new InstantWalletError(
      "The server fare is invalid.",
      500,
      "INVALID_SERVER_FARE"
    );
  }

  return fare;
}

async function refundRequestWithinTransaction(
  client,
  request,
  finalStatus,
  reason
) {
  if (
    request.payment_method !== "wallet"
    || request.payment_status !== "paid"
  ) {
    const result = await client.query(
      `UPDATE instant_ride_requests
          SET status = $1,
              updated_at = now()
        WHERE id = $2
        RETURNING *`,
      [finalStatus, request.id]
    );

    await client.query(
      `UPDATE instant_ride_offers
          SET status = 'lost',
              responded_at =
                COALESCE(responded_at, now())
        WHERE request_id = $1
          AND status = 'offered'`,
      [request.id]
    );

    return {
      request: result.rows[0],
      refunded: false,
      balanceNaira: null,
    };
  }

  const fareNaira = positiveFare(
    request.estimated_fare_naira
  );

  const userResult = await client.query(
    `SELECT wallet_balance_naira
       FROM users
      WHERE id = $1
      FOR UPDATE`,
    [request.rider_id]
  );

  if (!userResult.rows[0]) {
    throw new InstantWalletError(
      "The rider account no longer exists.",
      409,
      "RIDER_NOT_FOUND"
    );
  }

  const balanceResult = await client.query(
    `UPDATE users
        SET wallet_balance_naira =
              wallet_balance_naira + $1
      WHERE id = $2
      RETURNING wallet_balance_naira`,
    [
      fareNaira,
      request.rider_id,
    ]
  );

  const newBalance = Number(
    balanceResult.rows[0].wallet_balance_naira
  );

  const refundResult = await client.query(
    `INSERT INTO wallet_transactions (
       user_id,
       type,
       status,
       amount_naira,
       balance_after_naira,
       ride_id,
       description
     )
     VALUES (
       $1,
       'refund',
       'completed',
       $2,
       $3,
       NULL,
       $4
     )
     RETURNING id`,
    [
      request.rider_id,
      fareNaira,
      newBalance,
      `ArrivoExpress refund, request #${request.id}: ${reason}`,
    ]
  );

  await client.query(
    `UPDATE instant_ride_offers
        SET status = 'lost',
            responded_at =
              COALESCE(responded_at, now())
      WHERE request_id = $1
        AND status = 'offered'`,
    [request.id]
  );

  const requestResult = await client.query(
    `UPDATE instant_ride_requests
        SET status = $1,
            payment_status = 'refunded',
            refunded_at = now(),
            refund_wallet_transaction_id = $2,
            updated_at = now()
      WHERE id = $3
      RETURNING *`,
    [
      finalStatus,
      refundResult.rows[0].id,
      request.id,
    ]
  );

  return {
    request: requestResult.rows[0],
    refunded: true,
    balanceNaira: newBalance,
  };
}

async function createWalletFundedRequest({
  riderId,
  trip,
  quote,
}) {
  const fareNaira = positiveFare(
    quote?.fareNaira
  );

  const distanceKm = Number(
    quote?.distanceKm
  );

  const durationMin = Number(
    quote?.durationMin
  );

  if (
    !Number.isFinite(distanceKm)
    || distanceKm < 0
    || !Number.isFinite(durationMin)
    || durationMin < 0
  ) {
    throw new InstantWalletError(
      "The server route estimate is invalid.",
      500,
      "INVALID_SERVER_ROUTE"
    );
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Serialises competing ArrivoExpress creation attempts for one rider.
    const userResult = await client.query(
      `SELECT
         role,
         wallet_balance_naira
       FROM users
       WHERE id = $1
       FOR UPDATE`,
      [riderId]
    );

    const user = userResult.rows[0];

    if (!user) {
      throw new InstantWalletError(
        "Rider account not found.",
        404,
        "RIDER_NOT_FOUND"
      );
    }

    if (user.role !== "rider") {
      throw new InstantWalletError(
        "Only rider accounts can request ArrivoExpress.",
        403,
        "RIDER_ROLE_REQUIRED"
      );
    }

    const existingRequest = await client.query(
      `SELECT id, status
         FROM instant_ride_requests
        WHERE rider_id = $1
          AND status IN (
            'searching',
            'offering',
            'matched'
          )
          AND ride_id IS NULL
        ORDER BY created_at DESC
        LIMIT 1`,
      [riderId]
    );

    if (existingRequest.rows[0]) {
      throw new InstantWalletError(
        "You already have an active ArrivoExpress request.",
        409,
        "ACTIVE_INSTANT_REQUEST",
        {
          requestId:
            existingRequest.rows[0].id,
          requestStatus:
            existingRequest.rows[0].status,
        }
      );
    }

    const activeRide = await client.query(
      `SELECT id, ride_status
         FROM rides
        WHERE rider_id = $1
          AND ride_status IN (
            'accepted',
            'in_progress'
          )
        ORDER BY created_at DESC
        LIMIT 1`,
      [riderId]
    );

    if (activeRide.rows[0]) {
      throw new InstantWalletError(
        "You already have an active RideArrivo trip.",
        409,
        "ACTIVE_RIDE",
        {
          rideId: activeRide.rows[0].id,
          rideStatus:
            activeRide.rows[0].ride_status,
        }
      );
    }

    const balance = Number(
      user.wallet_balance_naira
    );

    if (balance < fareNaira) {
      throw new InstantWalletError(
        "Insufficient wallet balance for this ArrivoExpress ride.",
        400,
        "INSUFFICIENT_WALLET",
        {
          balanceNaira: balance,
          fareNaira,
        }
      );
    }

    const requestResult = await client.query(
      `INSERT INTO instant_ride_requests (
         rider_id,
         pickup_address,
         pickup_lat,
         pickup_lng,
         destination_address,
         destination_lat,
         destination_lng,
         vehicle_type,
         tier,
         min_seats,
         estimated_fare_naira,
         fare_breakdown,
         estimated_distance_km,
         estimated_duration_min,
         status,
         payment_method,
         payment_status,
         expires_at
       )
       VALUES (
         $1,
         $2,
         $3,
         $4,
         $5,
         $6,
         $7,
         $8,
         $9,
         $10,
         $11,
         $12,
         $13,
         $14,
         'searching',
         'wallet',
         'paid',
         now() + interval '5 minutes'
       )
       RETURNING *`,
      [
        riderId,
        trip.pickupAddress,
        trip.pickupLat,
        trip.pickupLng,
        trip.destinationAddress,
        trip.destinationLat,
        trip.destinationLng,
        trip.vehicleType,
        trip.tier || null,
        Number.isInteger(trip.minSeats) && trip.minSeats > 0 ? trip.minSeats : 1,
        fareNaira,
        quote?.breakdown ? JSON.stringify(quote.breakdown) : null,
        distanceKm,
        durationMin,
      ]
    );

    let request = requestResult.rows[0];

    const balanceResult = await client.query(
      `UPDATE users
          SET wallet_balance_naira =
                wallet_balance_naira - $1
        WHERE id = $2
        RETURNING wallet_balance_naira`,
      [
        fareNaira,
        riderId,
      ]
    );

    const newBalance = Number(
      balanceResult.rows[0].wallet_balance_naira
    );

    const walletResult = await client.query(
      `INSERT INTO wallet_transactions (
         user_id,
         type,
         status,
         amount_naira,
         balance_after_naira,
         ride_id,
         description
       )
       VALUES (
         $1,
         'ride_charge',
         'completed',
         $2,
         $3,
         NULL,
         $4
       )
       RETURNING id`,
      [
        riderId,
        -fareNaira,
        newBalance,
        `ArrivoExpress request #${request.id} (${trip.pickupAddress})`,
      ]
    );

    const updatedRequest = await client.query(
      `UPDATE instant_ride_requests
          SET wallet_transaction_id = $1,
              updated_at = now()
        WHERE id = $2
        RETURNING *`,
      [
        walletResult.rows[0].id,
        request.id,
      ]
    );

    request = updatedRequest.rows[0];

    await client.query("COMMIT");

    return {
      request,
      balanceNaira: newBalance,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function cancelWalletFundedRequest(
  riderId,
  requestId
) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const result = await client.query(
      `SELECT *
         FROM instant_ride_requests
        WHERE id = $1
          AND rider_id = $2
        FOR UPDATE`,
      [
        requestId,
        riderId,
      ]
    );

    const request = result.rows[0];

    if (!request) {
      throw new InstantWalletError(
        "ArrivoExpress request not found.",
        404,
        "REQUEST_NOT_FOUND"
      );
    }

    if (
      request.status === "cancelled"
      || request.status === "expired"
    ) {
      await client.query("COMMIT");

      return {
        request,
        refunded:
          request.payment_status === "refunded",
        alreadyFinal: true,
        balanceNaira: null,
      };
    }

    if (
      request.status === "matched"
      || request.matched_driver_id
      || request.ride_id
    ) {
      throw new InstantWalletError(
        "This ArrivoExpress request has already been matched. Use the normal ride cancellation flow.",
        409,
        "REQUEST_ALREADY_MATCHED"
      );
    }

    const refunded =
      await refundRequestWithinTransaction(
        client,
        request,
        "cancelled",
        "rider cancelled before driver match"
      );

    await client.query("COMMIT");

    return refunded;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// Must be called inside a transaction.
//
// expireStaleOffers() provides that transaction when invoked with the
// shared pool, and reuses its caller's transaction when given a PoolClient.
async function expireInstantRequestsWithRefund(
  client
) {
  const result = await client.query(
    `SELECT *
       FROM instant_ride_requests
      WHERE status IN (
        'searching',
        'offering'
      )
        AND expires_at <= now()
        AND matched_driver_id IS NULL
        AND ride_id IS NULL
      ORDER BY expires_at ASC
      FOR UPDATE SKIP LOCKED`
  );

  let expired = 0;
  let refunded = 0;

  for (const request of result.rows) {
    const outcome =
      await refundRequestWithinTransaction(
        client,
        request,
        "expired",
        "no driver was matched before the ArrivoExpress request expired"
      );

    expired += 1;

    if (outcome.refunded) {
      refunded += 1;
    }
  }

  return {
    expired,
    refunded,
  };
}

module.exports = {
  InstantWalletError,
  createWalletFundedRequest,
  cancelWalletFundedRequest,
  expireInstantRequestsWithRefund,
  refundRequestWithinTransaction,
};
