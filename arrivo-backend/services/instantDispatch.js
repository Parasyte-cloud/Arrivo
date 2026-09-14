const { pool } = require("../db/db");
const { sendPushNotification } = require("./pushNotifications");
const {
  expireInstantRequestsWithRefund,
} = require("./instantWallet");

function integerEnv(name, fallback, min, max) {
  const raw = Number(process.env[name]);
  if (!Number.isInteger(raw)) return fallback;
  return Math.min(Math.max(raw, min), max);
}

function numericEnv(name, fallback, min, max) {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(Math.max(raw, min), max);
}

function getInstantDispatchConfig() {
  return {
    locationMaxAgeSeconds: integerEnv(
      "ARRIVO_NOW_LOCATION_MAX_AGE_SECONDS",
      45,
      10,
      300
    ),
    offerTtlSeconds: integerEnv(
      "ARRIVO_NOW_OFFER_TTL_SECONDS",
      20,
      10,
      120
    ),
    initialRadiusKm: numericEnv(
      "ARRIVO_NOW_INITIAL_RADIUS_KM",
      3,
      0.5,
      25
    ),
    offerBatchSize: integerEnv(
      "ARRIVO_NOW_OFFER_BATCH_SIZE",
      3,
      1,
      10
    ),
  };
}

async function expireStaleOffers(db = pool) {
  // When called with the shared Pool, make expiry + wallet refund one
  // transaction. createOfferBatch already passes a PoolClient while its
  // own transaction is open, so that path reuses the surrounding lock.
  if (db === pool) {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");
      const result = await expireStaleOffers(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  const requestExpiry =
    await expireInstantRequestsWithRefund(db);

  await db.query(
    `UPDATE instant_ride_offers
        SET status = 'expired',
            responded_at =
              COALESCE(responded_at, now())
      WHERE status = 'offered'
        AND expires_at <= now()`
  );

  await db.query(
    `UPDATE instant_ride_requests r
        SET status = 'searching',
            updated_at = now()
      WHERE r.status = 'offering'
        AND r.expires_at > now()
        AND r.matched_driver_id IS NULL
        AND r.ride_id IS NULL
        AND NOT EXISTS (
          SELECT 1
            FROM instant_ride_offers o
           WHERE o.request_id = r.id
             AND o.status = 'offered'
             AND o.expires_at > now()
        )`
  );

  return requestExpiry;
}

async function findEligibleDrivers(
  db,
  {
    requestId,
    pickupLat,
    pickupLng,
    vehicleType,
    minSeats,
    radiusKm,
    batchSize,
  }
) {
  const config = getInstantDispatchConfig();

  const result = await db.query(
    `SELECT
       d.id AS driver_id,
       d.user_id,
       u.name AS driver_name,
       u.push_token,
       v.vehicle_type,
       v.seats,
       distance.distance_to_pickup_km
     FROM drivers d
     JOIN users u
       ON u.id = d.user_id
     JOIN vehicles v
       ON v.id = d.vehicle_id
     CROSS JOIN LATERAL (
       SELECT
         6371.0 * acos(
           LEAST(
             1.0,
             GREATEST(
               -1.0,
               cos(radians($2::double precision))
               * cos(radians(d.current_lat))
               * cos(
                   radians(d.current_lng)
                   - radians($3::double precision)
                 )
               + sin(radians($2::double precision))
               * sin(radians(d.current_lat))
             )
           )
         ) AS distance_to_pickup_km
     ) distance
     WHERE d.is_verified = true
       AND d.is_online = true
       AND d.accepts_instant = true
       AND d.current_lat IS NOT NULL
       AND d.current_lng IS NOT NULL
       AND d.location_updated_at IS NOT NULL
       AND d.location_updated_at
           >= now() - ($4::int * interval '1 second')
       AND ($5::text IS NULL OR v.vehicle_type = $5)
       AND COALESCE(v.seats, 1) >= $8::int
       AND distance.distance_to_pickup_km <= $6::double precision

       AND NOT EXISTS (
         SELECT 1
           FROM rides active_ride
          WHERE active_ride.driver_id = d.id
            AND active_ride.ride_status
                IN ('accepted', 'in_progress')
       )

       AND NOT EXISTS (
         SELECT 1
           FROM instant_ride_offers previous_offer
          WHERE previous_offer.request_id = $1
            AND previous_offer.driver_id = d.id
       )

       AND NOT EXISTS (
         SELECT 1
           FROM instant_ride_offers live_offer
          WHERE live_offer.driver_id = d.id
            AND live_offer.status = 'offered'
            AND live_offer.expires_at > now()
       )

     ORDER BY distance.distance_to_pickup_km ASC
     LIMIT $7
     FOR UPDATE OF d SKIP LOCKED`,
    [
      requestId,
      pickupLat,
      pickupLng,
      config.locationMaxAgeSeconds,
      vehicleType || null,
      radiusKm,
      batchSize,
      Number.isInteger(minSeats) && minSeats > 0 ? minSeats : 1,
    ]
  );

  return result.rows;
}

async function createOfferBatch(requestId, options = {}) {
  const config = getInstantDispatchConfig();

  const radiusKm =
    Number.isFinite(Number(options.radiusKm))
      ? Number(options.radiusKm)
      : config.initialRadiusKm;

  const batchSize =
    Number.isInteger(Number(options.batchSize))
      ? Math.min(
          Math.max(Number(options.batchSize), 1),
          10
        )
      : config.offerBatchSize;

  const client = await pool.connect();

  let request = null;
  let createdOffers = [];

  try {
    await client.query("BEGIN");

    await expireStaleOffers(client);

    const requestResult = await client.query(
      `SELECT *
         FROM instant_ride_requests
        WHERE id = $1
        FOR UPDATE`,
      [requestId]
    );

    request = requestResult.rows[0];

    if (!request) {
      await client.query("ROLLBACK");
      return {
        status: "not_found",
        offers: [],
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
        request,
        offers: [],
      };
    }

    if (
      request.status === "cancelled"
      || request.status === "expired"
    ) {
      await client.query("ROLLBACK");
      return {
        status: request.status,
        request,
        offers: [],
      };
    }

    if (new Date(request.expires_at).getTime() <= Date.now()) {
      await client.query(
        `UPDATE instant_ride_requests
            SET status = 'expired',
                updated_at = now()
          WHERE id = $1`,
        [request.id]
      );

      await client.query("COMMIT");

      return {
        status: "expired",
        request: {
          ...request,
          status: "expired",
        },
        offers: [],
      };
    }

    const existingOffers = await client.query(
      `SELECT *
         FROM instant_ride_offers
        WHERE request_id = $1
          AND status = 'offered'
          AND expires_at > now()
        ORDER BY offered_at ASC`,
      [request.id]
    );

    if (existingOffers.rows.length) {
      await client.query("COMMIT");

      return {
        status: "already_offering",
        request,
        offers: existingOffers.rows,
      };
    }

    const drivers = await findEligibleDrivers(client, {
      requestId: request.id,
      pickupLat: Number(request.pickup_lat),
      pickupLng: Number(request.pickup_lng),
      vehicleType: request.vehicle_type,
      minSeats: request.min_seats,
      radiusKm,
      batchSize,
    });

    for (const driver of drivers) {
      const inserted = await client.query(
        `INSERT INTO instant_ride_offers (
           request_id,
           driver_id,
           status,
           distance_to_pickup_km,
           expires_at
         )
         VALUES (
           $1,
           $2,
           'offered',
           $3,
           now() + ($4::int * interval '1 second')
         )
         ON CONFLICT (request_id, driver_id)
         DO NOTHING
         RETURNING *`,
        [
          request.id,
          driver.driver_id,
          driver.distance_to_pickup_km,
          config.offerTtlSeconds,
        ]
      );

      if (inserted.rows[0]) {
        createdOffers.push({
          ...inserted.rows[0],
          driver_name: driver.driver_name,
          push_token: driver.push_token,
        });
      }
    }

    await client.query(
      `UPDATE instant_ride_requests
          SET status = $1,
              updated_at = now()
        WHERE id = $2`,
      [
        createdOffers.length
          ? "offering"
          : "searching",
        request.id,
      ]
    );

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  for (const offer of createdOffers) {
    sendPushNotification(
      offer.push_token,
      "ArrivoNow request nearby",
      "A new RideArrivo trip is available near you.",
      {
        type: "arrivo_now_offer",
        offerId: offer.id,
        requestId: request.id,
      }
    ).catch(() => {});
  }

  return {
    status: createdOffers.length
      ? "offering"
      : "no_drivers",
    request,
    offers: createdOffers.map(
      ({ push_token, ...offer }) => offer
    ),
  };
}

async function listDriverOffers(driverId) {
  await expireStaleOffers(pool);

  const result = await pool.query(
    `SELECT
       o.id AS offer_id,
       o.request_id,
       o.status,
       o.distance_to_pickup_km,
       o.eta_to_pickup_min,
       o.offered_at,
       o.expires_at,

       r.pickup_address,
       r.pickup_lat,
       r.pickup_lng,
       r.destination_address,
       r.destination_lat,
       r.destination_lng,
       r.vehicle_type,
       r.estimated_fare_naira,
       r.estimated_distance_km,
       r.estimated_duration_min,

       rider.name AS rider_name

     FROM instant_ride_offers o
     JOIN instant_ride_requests r
       ON r.id = o.request_id
     JOIN users rider
       ON rider.id = r.rider_id

     WHERE o.driver_id = $1
       AND o.status = 'offered'
       AND o.expires_at > now()
       AND r.status = 'offering'
       AND r.expires_at > now()
       AND r.matched_driver_id IS NULL
       AND r.ride_id IS NULL

     ORDER BY o.offered_at ASC`,
    [driverId]
  );

  return result.rows;
}

async function declineOffer(driverId, offerId) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await expireStaleOffers(client);

    const offerResult = await client.query(
      `SELECT o.*
         FROM instant_ride_offers o
        WHERE o.id = $1
          AND o.driver_id = $2
        FOR UPDATE`,
      [offerId, driverId]
    );

    const offer = offerResult.rows[0];

    if (!offer) {
      await client.query("ROLLBACK");
      return { status: "not_found" };
    }

    if (offer.status !== "offered") {
      await client.query("ROLLBACK");
      return {
        status: "already_responded",
        offerStatus: offer.status,
      };
    }

    if (new Date(offer.expires_at).getTime() <= Date.now()) {
      await client.query(
        `UPDATE instant_ride_offers
            SET status = 'expired',
                responded_at = now()
          WHERE id = $1`,
        [offer.id]
      );

      await client.query("COMMIT");

      return {
        status: "expired",
        requestId: offer.request_id,
      };
    }

    await client.query(
      `UPDATE instant_ride_offers
          SET status = 'declined',
              responded_at = now()
        WHERE id = $1`,
      [offer.id]
    );

    const otherLiveOffers = await client.query(
      `SELECT 1
         FROM instant_ride_offers
        WHERE request_id = $1
          AND status = 'offered'
          AND expires_at > now()
        LIMIT 1`,
      [offer.request_id]
    );

    if (!otherLiveOffers.rows.length) {
      await client.query(
        `UPDATE instant_ride_requests
            SET status = CASE
                  WHEN expires_at <= now()
                    THEN 'expired'
                  ELSE 'searching'
                END,
                updated_at = now()
          WHERE id = $1
            AND status = 'offering'
            AND matched_driver_id IS NULL
            AND ride_id IS NULL`,
        [offer.request_id]
      );
    }

    await client.query("COMMIT");

    return {
      status: "declined",
      requestId: offer.request_id,
      offerId: offer.id,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  getInstantDispatchConfig,
  expireStaleOffers,
  findEligibleDrivers,
  createOfferBatch,
  listDriverOffers,
  declineOffer,
};
