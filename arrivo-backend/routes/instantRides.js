const express = require("express");
const { pool } = require("../db/db");
const {
  requireAuth,
  requireRole,
} = require("../middleware/auth");
const { getDriverForUser } = require("./drivers");
const {
  sendDriverAssignedEmail,
} = require("../services/email");
const {
  sendPushNotification,
} = require("../services/pushNotifications");
const {
  sendWhatsAppMessage,
  driverAssignedMessage,
} = require("../services/whatsapp");
const {
  getInstantDispatchConfig,
  createOfferBatch,
  expireStaleOffers,
  listDriverOffers,
  declineOffer,
} = require("../services/instantDispatch");
const {
  quoteInstantRide,
  InstantQuoteError,
} = require("../services/instantQuote");
const {
  InstantWalletError,
  createWalletFundedRequest,
  cancelWalletFundedRequest,
} = require("../services/instantWallet");
const {
  acceptInstantOffer,
} = require("../services/instantAcceptance");
const {
  listTiers,
} = require("../services/instantTiers");

const router = express.Router();

function isArrivoNowEnabled() {
  return String(process.env.ARRIVO_NOW_ENABLED || "")
    .trim()
    .toLowerCase() === "true";
}

async function notifyInstantMatch(
  rideId,
  driverId
) {
  const rideResult = await pool.query(
    `SELECT
       rides.*,
       users.name AS rider_name,
       users.phone AS rider_phone,
       users.push_token AS rider_push_token,
       users.email AS rider_email,
       users.whatsapp_number AS rider_whatsapp_number
     FROM rides
     JOIN users
       ON users.id = rides.rider_id
     WHERE rides.id = $1`,
    [rideId]
  );

  const ride = rideResult.rows[0];

  if (!ride) return;

  const driverResult = await pool.query(
    `SELECT
       users.name AS driver_name,
       vehicles.make_model,
       vehicles.plate_number
     FROM drivers
     JOIN users
       ON users.id = drivers.user_id
     LEFT JOIN vehicles
       ON vehicles.id = drivers.vehicle_id
     WHERE drivers.id = $1`,
    [driverId]
  );

  const driver =
    driverResult.rows[0] || {};

  const driverName =
    driver.driver_name
    || "Your driver";

  const vehicleLabel =
    driver.make_model
      ? `${driver.make_model}${
          driver.plate_number
            ? ` — ${driver.plate_number}`
            : ""
        }`
      : null;

  sendPushNotification(
    ride.rider_push_token,
    "Driver on the way",
    `${driverName} accepted your ArrivoExpress ride and is heading your way.`,
    {
      rideId: ride.id,
      type: "ride_accepted",
      serviceMode: "instant",
    }
  ).catch(() => {});

  if (ride.rider_whatsapp_number) {
    sendWhatsAppMessage(
      ride.rider_whatsapp_number,
      driverAssignedMessage(
        ride,
        driverName,
        vehicleLabel
      )
    ).catch(() => {});
  }

  if (ride.rider_email) {
    sendDriverAssignedEmail(
      ride.rider_email,
      ride,
      driverName,
      vehicleLabel
    ).catch(() => {});
  }
}

// GET /api/instant-rides/status
//
// Shared capability endpoint for rider and driver applications.
// ArrivoExpress fails closed unless the backend flag is explicitly true.
router.get("/status", requireAuth, (req, res) => {
  const enabled = isArrivoNowEnabled();

  res.json({
    service: "ArrivoExpress",
    serviceMode: "instant",
    enabled,
    paymentMethods: enabled ? ["wallet"] : [],
  });
});

// GET /api/instant-rides/tiers
//
// Rider-facing vehicle tier catalogue (Economy/Comfort/XL/Premium) — the
// app renders this list as the "choose your vehicle" step before quoting.
// Available regardless of the ARRIVO_NOW_ENABLED flag so the UI can be
// built and reviewed before the feature is switched on for riders.
router.get("/tiers", requireAuth, (req, res) => {
  res.json({
    tiers: listTiers(),
  });
});

// POST /api/instant-rides/quote
//
// Fare and route data are always calculated by the backend. The app may
// display this result, but it never gets to choose the amount charged.
router.post(
  "/quote",
  requireAuth,
  requireRole("rider"),
  async (req, res) => {
    if (!isArrivoNowEnabled()) {
      return res.status(503).json({
        error: "ArrivoExpress is not available yet.",
      });
    }

    try {
      const quote = await quoteInstantRide(req.body);

      return res.json({
        quote,
      });
    } catch (error) {
      if (error instanceof InstantQuoteError) {
        return res.status(error.status).json({
          error: error.message,
          code: error.code,
        });
      }

      throw error;
    }
  }
);

// POST /api/instant-rides
//
// Wallet is the first enabled settlement rail. The route computes the fare
// again on the server immediately before charging; client-submitted fare
// values are intentionally ignored.
router.post(
  "/",
  requireAuth,
  requireRole("rider"),
  async (req, res) => {
    if (!isArrivoNowEnabled()) {
      return res.status(503).json({
        error: "ArrivoExpress is not available yet.",
      });
    }

    if (
      req.body.paymentMethod !== undefined
      && req.body.paymentMethod !== "wallet"
    ) {
      return res.status(400).json({
        error:
          "Only RideArrivo Wallet is enabled for ArrivoExpress during this rollout.",
        code: "PAYMENT_METHOD_NOT_ENABLED",
      });
    }

    try {
      const quote = await quoteInstantRide(req.body);

      const funded =
        await createWalletFundedRequest({
          riderId: req.user.id,
          trip: quote,
          quote,
        });

      let dispatch;

      try {
        dispatch = await createOfferBatch(
          funded.request.id
        );
      } catch (error) {
        // The payment/request transaction has already committed. Do not
        // duplicate or reverse money based on a transient dispatch error.
        // The request remains searchable and can still be cancelled/refunded.
        console.error(
          `ArrivoExpress dispatch kick failed for request #${funded.request.id}:`,
          error.message
        );

        dispatch = {
          status: "deferred",
          offers: [],
        };
      }

      return res.status(201).json({
        request: funded.request,
        balanceNaira: funded.balanceNaira,
        quote,
        dispatch,
      });
    } catch (error) {
      if (error instanceof InstantQuoteError) {
        return res.status(error.status).json({
          error: error.message,
          code: error.code,
        });
      }

      if (error instanceof InstantWalletError) {
        return res.status(error.status).json({
          error: error.message,
          code: error.code,
          ...error.details,
        });
      }

      if (error?.code === "23505") {
        return res.status(409).json({
          error:
            "You already have an active ArrivoExpress request.",
          code: "ACTIVE_INSTANT_REQUEST",
        });
      }

      throw error;
    }
  }
);

// POST /api/instant-rides/rider/requests/:requestId/cancel
router.post(
  "/rider/requests/:requestId/cancel",
  requireAuth,
  requireRole("rider"),
  async (req, res) => {
    const requestId = Number(
      req.params.requestId
    );

    if (
      !Number.isInteger(requestId)
      || requestId <= 0
      || requestId > 2147483647
    ) {
      return res.status(400).json({
        error:
          "requestId must be a valid positive integer",
      });
    }

    try {
      const result =
        await cancelWalletFundedRequest(
          req.user.id,
          requestId
        );

      return res.json(result);
    } catch (error) {
      if (error instanceof InstantWalletError) {
        return res.status(error.status).json({
          error: error.message,
          code: error.code,
          ...error.details,
        });
      }

      throw error;
    }
  }
);

// PATCH /api/instant-rides/driver/availability
//
// This preference is separate from the driver's normal online/offline state.
// A driver must be BOTH online and opted into ArrivoExpress to receive offers.
router.patch(
  "/driver/availability",
  requireAuth,
  requireRole("driver"),
  async (req, res) => {
    const { acceptsInstant } = req.body;

    if (typeof acceptsInstant !== "boolean") {
      return res.status(400).json({
        error: "acceptsInstant must be a boolean",
      });
    }

    const driver = await getDriverForUser(req.user.id);

    if (!driver) {
      return res.status(404).json({
        error: "Complete your driver profile first",
      });
    }

    if (acceptsInstant && !driver.is_verified) {
      return res.status(403).json({
        error:
          "Your driver profile must be verified before enabling ArrivoExpress.",
      });
    }

    await pool.query(
      `UPDATE drivers
          SET accepts_instant = $1
        WHERE id = $2`,
      [acceptsInstant, driver.id]
    );

    res.json({
      acceptsInstant,
      arrivoExpressEnabled: isArrivoNowEnabled(),
    });
  }
);

// GET /api/instant-rides/driver/offers
//
// Deliberately separate from GET /api/rides/available so an unmatched
// ArrivoExpress request can never leak into the scheduled/general claim queue.
router.get(
  "/driver/offers",
  requireAuth,
  requireRole("driver"),
  async (req, res) => {
    if (!isArrivoNowEnabled()) {
      return res.json({
        enabled: false,
        offers: [],
      });
    }

    const driver = await getDriverForUser(req.user.id);

    if (!driver) {
      return res.status(404).json({
        error: "Complete your driver profile first",
      });
    }

    if (!driver.is_verified) {
      return res.status(403).json({
        error:
          "Your driver profile must be verified before receiving ArrivoExpress offers.",
      });
    }

    const offers = await listDriverOffers(driver.id);

    res.json({
      enabled: true,
      offers,
      dispatch: getInstantDispatchConfig(),
    });
  }
);

// POST /api/instant-rides/driver/offers/:offerId/accept
//
// The winning transaction converts an already-funded ArrivoExpress request into
// a normal paid RideArrivo ride. No client-provided fare or rider id is used.
router.post(
  "/driver/offers/:offerId/accept",
  requireAuth,
  requireRole("driver"),
  async (req, res) => {
    if (!isArrivoNowEnabled()) {
      return res.status(503).json({
        error: "ArrivoExpress is not available yet.",
      });
    }

    const offerId = Number(
      req.params.offerId
    );

    if (
      !Number.isInteger(offerId)
      || offerId <= 0
      || offerId > 2147483647
    ) {
      return res.status(400).json({
        error:
          "offerId must be a valid positive integer",
      });
    }

    const driver =
      await getDriverForUser(
        req.user.id
      );

    if (!driver) {
      return res.status(404).json({
        error:
          "Complete your driver profile first",
      });
    }

    const result =
      await acceptInstantOffer({
        driverId: driver.id,
        offerId,
      });

    if (
      result.status === "accepted"
    ) {
      if (
        !result.alreadyAccepted
        && result.ride
      ) {
        notifyInstantMatch(
          result.ride.id,
          driver.id
        ).catch((error) => {
          console.error(
            `ArrivoExpress match notification failed for Ride #${result.ride.id}:`,
            error.message
          );
        });
      }

      return res.json(result);
    }

    if (
      result.status === "not_found"
      || result.status
        === "driver_not_found"
    ) {
      return res.status(404).json({
        error:
          "ArrivoExpress offer not found",
        code:
          "ARRIVONOW_OFFER_NOT_FOUND",
      });
    }

    if (
      result.status === "expired"
      || result.status
        === "offer_expired"
    ) {
      return res.status(410).json({
        error:
          "This ArrivoExpress offer has expired.",
        code:
          "ARRIVONOW_OFFER_EXPIRED",
        ...result,
      });
    }

    if (
      result.status === "already_matched"
    ) {
      return res.status(409).json({
        error:
          "Another driver already accepted this ArrivoExpress request.",
        code:
          "ARRIVONOW_ALREADY_MATCHED",
        ...result,
      });
    }

    if (
      result.status === "cancelled"
    ) {
      return res.status(409).json({
        error:
          "The rider cancelled this ArrivoExpress request.",
        code:
          "ARRIVONOW_CANCELLED",
      });
    }

    if (
      result.status === "driver_busy"
    ) {
      return res.status(409).json({
        error:
          "You already have an active RideArrivo trip.",
        code:
          "DRIVER_ALREADY_ACTIVE",
        ...result,
      });
    }

    if (
      result.status === "driver_ineligible"
    ) {
      return res.status(409).json({
        error:
          "You are no longer eligible to accept this ArrivoExpress offer.",
        code:
          "DRIVER_NOT_ELIGIBLE",
      });
    }

    if (
      result.status === "payment_not_secured"
    ) {
      return res.status(409).json({
        error:
          "This ArrivoExpress request no longer has a secured payment.",
        code:
          "ARRIVONOW_PAYMENT_NOT_SECURED",
      });
    }

    return res.status(409).json({
      error:
        "This ArrivoExpress offer is no longer active.",
      code:
        "ARRIVONOW_OFFER_INACTIVE",
      ...result,
    });
  }
);

// POST /api/instant-rides/driver/offers/:offerId/decline
router.post(
  "/driver/offers/:offerId/decline",
  requireAuth,
  requireRole("driver"),
  async (req, res) => {
    const offerId = Number(req.params.offerId);

    if (!Number.isInteger(offerId) || offerId <= 0) {
      return res.status(400).json({
        error: "offerId must be a positive integer",
      });
    }

    const driver = await getDriverForUser(req.user.id);

    if (!driver) {
      return res.status(404).json({
        error: "Complete your driver profile first",
      });
    }

    const result = await declineOffer(
      driver.id,
      offerId
    );

    if (result.status === "not_found") {
      return res.status(404).json({
        error: "ArrivoExpress offer not found",
      });
    }

    if (result.status === "already_responded") {
      return res.status(409).json({
        error: "This ArrivoExpress offer is no longer active.",
        offerStatus: result.offerStatus,
      });
    }

    res.json(result);
  }
);

// GET /api/instant-rides/rider/active
//
// Read-only for now. Request creation/payment is intentionally introduced
// in the next batch after dispatch eligibility is proven independently.
router.get(
  "/rider/active",
  requireAuth,
  requireRole("rider"),
  async (req, res) => {
    if (!isArrivoNowEnabled()) {
      return res.json({
        enabled: false,
        request: null,
      });
    }

    // This also performs any due wallet refund atomically before the
    // rider sees their current ArrivoExpress state.
    await expireStaleOffers(pool);

    const result = await pool.query(
      `SELECT *
         FROM instant_ride_requests
        WHERE rider_id = $1
          AND status IN (
            'searching',
            'offering',
            'matched'
          )
        ORDER BY created_at DESC
        LIMIT 1`,
      [req.user.id]
    );

    res.json({
      enabled: true,
      request: result.rows[0] || null,
    });
  }
);

module.exports = router;
module.exports.isArrivoNowEnabled = isArrivoNowEnabled;
