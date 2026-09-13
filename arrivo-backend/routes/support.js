const express = require("express");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const { pool } = require("../db/db");
const { requireAuth, requireRole, requireAnyRole } = require("../middleware/auth");
const { requireWorkspaceActor } = require("../middleware/workspaceActorAuth");
const { computeFare, MAX_FULL_DAY_COUNT } = require("../services/fare");
const { getNgnPerUsd } = require("../services/fx");

const router = express.Router();

const TYPES = ["complaint", "inquiry", "support"];
const STATUSES = ["open", "closed"];

// Anyone signed in can file a ticket, so the only thing standing between us
// and a loop is this. Keyed by user id rather than IP on purpose: riders here
// are on mobile networks that put a lot of people behind one carrier NAT
// address, and an IP key would have strangers throttling each other.
// requireAuth runs before this, so req.user is always set.
//
// Only the write path is limited. The list and close routes are admin and
// support only, which is a much smaller and known set of people.
const submitLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.SUPPORT_TICKET_RATE_LIMIT) || 5,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => String(req.user.id),
  // The default handler answers in plain text. Everything else in this API
  // answers { error }, and the app reads that field to show a message.
  handler: (req, res) =>
    res.status(429).json({
      error:
        "That's a lot of messages in a short time. Give it a few minutes, or call us if it's urgent.",
    }),
});
const MAX_SUBJECT = 140;
const MAX_DESCRIPTION = 4000;

// POST /api/support/tickets
// body: { type, subject, description, rideId? }
router.post("/tickets", requireAuth, submitLimiter, async (req, res) => {
  const { type, subject, description, rideId } = req.body;

  if (!TYPES.includes(type)) {
    return res.status(400).json({ error: `type must be one of: ${TYPES.join(", ")}` });
  }

  const cleanSubject = String(subject || "").trim();
  const cleanDescription = String(description || "").trim();
  if (!cleanSubject) return res.status(400).json({ error: "subject is required" });
  if (cleanSubject.length > MAX_SUBJECT) {
    return res.status(400).json({ error: `subject must be ${MAX_SUBJECT} characters or fewer` });
  }
  if (!cleanDescription) return res.status(400).json({ error: "description is required" });
  if (cleanDescription.length > MAX_DESCRIPTION) {
    return res.status(400).json({ error: `description must be ${MAX_DESCRIPTION} characters or fewer` });
  }

  // The app sends the rider's latest booking id so support has context, but
  // don't just trust it. Two reasons: a bad id would hit an INTEGER column and
  // blow up as a 500 instead of a clean 400, and without the owner check you
  // could file a ticket against someone else's trip.
  let attachedRideId = null;
  if (rideId !== undefined && rideId !== null && rideId !== "") {
    // Coerce only from a number or a numeric string. Number(true) is 1 and
    // Number([7]) is 7, so a plain Number() here would turn a malformed
    // value into a real id and quietly attach a ride nobody named. Upper
    // bound is Postgres's INTEGER max: anything past it reaches the column
    // and throws, which is the 500 this block exists to avoid.
    const asNumber =
      typeof rideId === "number" || typeof rideId === "string" ? Number(rideId) : NaN;
    if (!Number.isInteger(asNumber) || asNumber < 1 || asNumber > 2147483647) {
      return res.status(400).json({ error: "rideId must be a whole number" });
    }
    const owned = await pool.query("SELECT id FROM rides WHERE id = $1 AND rider_id = $2", [
      asNumber,
      req.user.id,
    ]);
    if (!owned.rows[0]) return res.status(400).json({ error: "That booking isn't on your account." });
    attachedRideId = owned.rows[0].id;
  }

  const result = await pool.query(
    `INSERT INTO support_tickets (user_id, ride_id, type, subject, description)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [req.user.id, attachedRideId, type, cleanSubject, cleanDescription]
  );
  res.status(201).json({ ticket: result.rows[0] });
});


// POST /api/support/assisted-bookings
//
// Creates only a durable pre-payment request. It does NOT create a ride,
// mark a ride paid, dispatch a driver or call the payment provider.
// The real ride is bound only after a later verified customer-payment path.
router.post(
  "/assisted-bookings",
  requireAuth,
  requireAnyRole(["admin", "support"]),
  requireWorkspaceActor,
  async (req, res) => {
    const workspaceActor = req.workspaceActor;

    if (
      !["support", "admin"].includes(
        workspaceActor.role
      )
    ) {
      return res.status(403).json({
        error:
          "Workspace actor is not authorised for assisted booking.",
      });
    }

    const actorEmployeeId = workspaceActor.employeeId;
    const payment_status = "pending";
    const source = "support_assisted";

    const body = req.body || {};

    const idempotencyKey =
      String(body.idempotencyKey || "").trim();

    const UUID_RE =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

    if (!UUID_RE.test(idempotencyKey)) {
      return res.status(400).json({
        error: "idempotencyKey must be a UUID.",
      });
    }

    let riderResult;

    if (
      body.riderId !== undefined &&
      body.riderId !== null &&
      body.riderId !== ""
    ) {
      const riderId = Number(body.riderId);

      if (
        !Number.isInteger(riderId) ||
        riderId < 1 ||
        riderId > 2147483647
      ) {
        return res.status(400).json({
          error: "riderId must be a valid whole number.",
        });
      }

      riderResult = await pool.query(
        `SELECT id, name, email, phone
         FROM users
         WHERE id = $1
           AND role = 'rider'`,
        [riderId]
      );
    } else {
      const email =
        String(body.email || "")
          .trim()
          .toLowerCase();

      const phone =
        String(body.phone || "").trim();

      if (!email && !phone) {
        return res.status(400).json({
          error:
            "Provide riderId, email or phone to identify the rider.",
        });
      }

      riderResult = await pool.query(
        `SELECT id, name, email, phone
         FROM users
         WHERE role = 'rider'
           AND (
             ($1 <> '' AND lower(email) = $1)
             OR
             ($2 <> '' AND phone = $2)
           )
         ORDER BY id
         LIMIT 3`,
        [email, phone]
      );

      if (riderResult.rows.length > 1) {
        return res.status(409).json({
          error:
            "Customer lookup is ambiguous. Select the rider by riderId.",
        });
      }
    }

    if (!riderResult.rows[0]) {
      return res.status(404).json({
        error: "No matching rider account was found.",
      });
    }

    const rider = riderResult.rows[0];

    const bookingType =
      String(body.bookingType || "one_way")
        .trim()
        .toLowerCase();

    const vehicleType =
      String(body.vehicleType || "")
        .trim()
        .toLowerCase();

    const pickupAddress =
      String(body.pickupAddress || "").trim();

    const destinationAddress =
      String(body.destinationAddress || "").trim();

    const flightNumber =
      String(body.flightNumber || "").trim() ||
      null;

    const adults =
      Number(body.adults ?? 1);

    const children =
      Number(body.children ?? 0);

    const durationDays =
      Number(body.durationDays ?? 1);

    const fleetSize =
      Number(body.fleetSize ?? 0);

    const securityEscort =
      Boolean(body.securityEscort);

    const luxury =
      Boolean(body.luxury);

    const agreedCancellationPolicy =
      body.agreedCancellationPolicy === true;

    const scheduledPickupAt =
      body.scheduledPickupAt
        ? String(body.scheduledPickupAt)
        : null;

    const allowedBookingTypes = [
      "one_way",
      "dropoff",
      "full_day",
      "full_week",
      "full_month",
    ];

    const allowedVehicleTypes = [
      "sedan",
      "suv",
      "truck",
      "pickup",
    ];

    if (!allowedBookingTypes.includes(bookingType)) {
      return res.status(400).json({
        error:
          `bookingType must be one of: ${allowedBookingTypes.join(", ")}`,
      });
    }

    if (!allowedVehicleTypes.includes(vehicleType)) {
      return res.status(400).json({
        error:
          `vehicleType must be one of: ${allowedVehicleTypes.join(", ")}`,
      });
    }

    if (!pickupAddress) {
      return res.status(400).json({
        error: "pickupAddress is required.",
      });
    }

    const oneWayStyle =
      bookingType === "one_way" ||
      bookingType === "dropoff";

    if (oneWayStyle && !destinationAddress) {
      return res.status(400).json({
        error:
          "destinationAddress is required for this booking type.",
      });
    }

    if (
      !Number.isInteger(adults) ||
      adults < 1 ||
      adults > 100
    ) {
      return res.status(400).json({
        error:
          "adults must be a whole number from 1 to 100.",
      });
    }

    if (
      !Number.isInteger(children) ||
      children < 0 ||
      children > 100
    ) {
      return res.status(400).json({
        error:
          "children must be a whole number from 0 to 100.",
      });
    }

    if (
      bookingType === "full_day" &&
      (
        !Number.isInteger(durationDays) ||
        durationDays < 1 ||
        durationDays > MAX_FULL_DAY_COUNT
      )
    ) {
      return res.status(400).json({
        error:
          `durationDays must be from 1 to ${MAX_FULL_DAY_COUNT}.`,
      });
    }

    if (![0, 2, 3].includes(fleetSize)) {
      return res.status(400).json({
        error: "fleetSize must be 0, 2, or 3.",
      });
    }

    if (
      bookingType === "one_way" &&
      !flightNumber
    ) {
      return res.status(400).json({
        error:
          "flightNumber is required for one-way bookings.",
      });
    }

    if (
      bookingType === "dropoff" &&
      !scheduledPickupAt
    ) {
      return res.status(400).json({
        error:
          "scheduledPickupAt is required for airport drop-off bookings.",
      });
    }

    if (scheduledPickupAt) {
      const parsed =
        new Date(scheduledPickupAt);

      if (
        Number.isNaN(parsed.getTime()) ||
        parsed.getTime() < Date.now()
      ) {
        return res.status(400).json({
          error:
            "scheduledPickupAt must be a valid future date/time.",
        });
      }
    }

    if (!agreedCancellationPolicy) {
      return res.status(400).json({
        error:
          "Customer agreement to the Cancellation & Refund Policy is required.",
      });
    }

    const passengerCount =
      adults + children;

    const normalizedRequest = {
      bookingType,
      pickupAddress,
      destinationAddress:
        destinationAddress || null,
      flightNumber,
      vehicleType,
      durationDays,
      adults,
      children,
      passengerCount,
      securityEscort,
      fleetSize,
      luxury,
      scheduledPickupAt,
      agreedCancellationPolicy: true,
    };

    const requestFingerprint =
      crypto
        .createHash("sha256")
        .update(
          JSON.stringify({
            riderId: rider.id,
            ...normalizedRequest,
          })
        )
        .digest("hex");

    const existing =
      await pool.query(
        `SELECT *
         FROM support_assisted_bookings
         WHERE idempotency_key = $1`,
        [idempotencyKey]
      );

    if (existing.rows[0]) {
      const prior = existing.rows[0];

      if (
        prior.actor_employee_id !==
          actorEmployeeId ||
        prior.request_fingerprint !==
          requestFingerprint
      ) {
        return res.status(409).json({
          error:
            "That idempotency key is already bound to another assisted booking.",
        });
      }

      return res.status(200).json({
        assistedBooking: {
          id: prior.id,
          riderId: prior.rider_id,
          fareNaira: prior.fare_naira,
          paymentStatus:
            prior.payment_status,
          rideId: prior.ride_id,
          requiresCustomerPayment:
            prior.payment_status !== "paid",
        },
      });
    }

    const ngnPerUsd =
      await getNgnPerUsd();

    let fareNaira;

    try {
      fareNaira =
        await computeFare({
          bookingType,
          pickupAddress,
          destinationAddress:
            destinationAddress || null,
          vehicleType,
          securityEscort,
          fleetSize,
          luxury,
          ngnPerUsd,
          durationDays,
          passengerCount,
        });
    } catch (error) {
      return res.status(400).json({
        error:
          error instanceof Error
            ? error.message
            : "Unable to calculate the assisted-booking fare.",
      });
    }

    const quotedUsdAmount =
      Number(
        (
          Number(fareNaira) /
          Number(ngnPerUsd)
        ).toFixed(2)
      );

    try {
      const inserted =
        await pool.query(
          `INSERT INTO support_assisted_bookings (
             rider_id,
             actor_employee_id,
             actor_role,
             actor_request_id,
             idempotency_key,
             request_fingerprint,
             source,
             payment_method,
             payment_status,
             payment_status_at_creation,
             booking_request,
             fare_naira,
             quoted_ngn_per_usd,
             quoted_usd_amount
           )
           VALUES (
             $1,$2,$3,$4,$5,$6,$7,
             'card',$8,'pending',
             $9::jsonb,$10,$11,$12
           )
           RETURNING *`,
          [
            rider.id,
            actorEmployeeId,
            workspaceActor.role,
            workspaceActor.requestId,
            idempotencyKey,
            requestFingerprint,
            source,
            payment_status,
            JSON.stringify(
              normalizedRequest
            ),
            fareNaira,
            ngnPerUsd,
            quotedUsdAmount,
          ]
        );

      const booking =
        inserted.rows[0];

      return res.status(201).json({
        assistedBooking: {
          id: booking.id,
          riderId: booking.rider_id,
          fareNaira:
            booking.fare_naira,
          quotedUsdAmount:
            booking.quoted_usd_amount,
          paymentStatus:
            booking.payment_status,
          rideId: booking.ride_id,
          requiresCustomerPayment: true,
        },
      });
    } catch (error) {
      if (error?.code === "23505") {
        const raced =
          await pool.query(
            `SELECT *
             FROM support_assisted_bookings
             WHERE idempotency_key = $1`,
            [idempotencyKey]
          );

        const prior =
          raced.rows[0];

        if (
          prior &&
          prior.actor_employee_id ===
            actorEmployeeId &&
          prior.request_fingerprint ===
            requestFingerprint
        ) {
          return res.status(200).json({
            assistedBooking: {
              id: prior.id,
              riderId:
                prior.rider_id,
              fareNaira:
                prior.fare_naira,
              paymentStatus:
                prior.payment_status,
              rideId:
                prior.ride_id,
              requiresCustomerPayment:
                prior.payment_status !==
                "paid",
            },
          });
        }

        return res.status(409).json({
          error:
            "This assisted-booking request has already been used.",
        });
      }

      throw error;
    }
  }
);

// GET /api/support/tickets. Ops only, newest first.
// Nothing in the admin dashboard reads this yet. It's here so tickets aren't
// write-only until that page gets built.
router.get("/tickets", requireAuth, requireAnyRole(["admin", "support"]), async (req, res) => {
  // Optional ?status= filter. It matters more than it looks: the list is
  // capped at 200 and ordered newest first, so once enough closed tickets
  // pile up an open one would drop off the end and never be seen again.
  const { status } = req.query;
  if (status !== undefined && !STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${STATUSES.join(", ")}` });
  }

  const result = await pool.query(
    `SELECT support_tickets.*,
            users.name AS user_name,
            users.email AS user_email,
            users.phone AS user_phone
     FROM support_tickets
     JOIN users ON users.id = support_tickets.user_id
     WHERE ($1::text IS NULL OR support_tickets.status = $1)
     ORDER BY support_tickets.created_at DESC
     LIMIT 200`
    , [status === undefined ? null : status]
  );
  res.json({ tickets: result.rows });
});

// PATCH /api/support/tickets/:id  body: { status }
// Closing is a mutation, so it needs admin specifically. The router-level
// requireAnyRole above lets support READ the queue, and per the roles note in
// ENGINEERING.md that read-only split is not automatic: every mutating route
// has to check for admin itself, which is what requireRole does here.
router.patch("/tickets/:id", requireAuth, requireRole("admin"), async (req, res) => {
  const { status } = req.body;
  if (!STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${STATUSES.join(", ")}` });
  }

  const id = Number(req.params.id);
  // Same bound as the rideId check above: past INTEGER range the value
  // reaches the column and throws a 500 instead of answering cleanly.
  if (!Number.isInteger(id) || id < 1 || id > 2147483647) {
    return res.status(400).json({ error: "That ticket id is not valid." });
  }

  const result = await pool.query(
    "UPDATE support_tickets SET status = $1 WHERE id = $2 RETURNING *",
    [status, id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: "No ticket with that id." });
  res.json({ ticket: result.rows[0] });
});

// Hung off the router so the tests can clear a key between cases without
// changing what server.js mounts.
router.submitLimiter = submitLimiter;

module.exports = router;
