const express = require("express");
const { pool } = require("../db/db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { getDriverForUser } = require("./drivers");
const { sendBookingConfirmationEmail } = require("../services/email");
const { sendPushNotification } = require("../services/pushNotifications");
const { verifyPaystackTransaction } = require("./payments");

const router = express.Router();

function withParsedStops(ride) {
  return { ...ride, stops: JSON.parse(ride.stops || "[]") };
}

// POST /api/rides — create a new ride/booking (requires auth)
// body: { pickupAddress, stops?, flightNumber?, vehicleType, fareNaira,
//         paymentReference?, bookingType?, durationDays?, agreedCancellationPolicy }
// bookingType: 'one_way' | 'full_day' | 'full_week' | 'full_month'
router.post("/", requireAuth, async (req, res) => {
  const {
    pickupAddress, stops, flightNumber, vehicleType, fareNaira, paymentReference,
    bookingType = "one_way", durationDays = 1, agreedCancellationPolicy,
    distanceKm, durationMin, securityEscort, fleetSize, paymentMethod = "card",
    emergencyContactName, emergencyContactPhone, dashCamConsent,
  } = req.body;

  if (!pickupAddress || !fareNaira) {
    return res.status(400).json({ error: "pickupAddress and fareNaira are required" });
  }
  const allowedTypes = ["one_way", "full_day", "full_week", "full_month"];
  if (!allowedTypes.includes(bookingType)) {
    return res.status(400).json({ error: `bookingType must be one of: ${allowedTypes.join(", ")}` });
  }
  if (!agreedCancellationPolicy) {
    return res.status(400).json({ error: "You must agree to the Cancellation & Refund Policy before booking" });
  }
  if (fleetSize && ![0, 2, 3].includes(fleetSize)) {
    return res.status(400).json({ error: "fleetSize must be 0, 2, or 3" });
  }
  if (!["card", "wallet", "membership"].includes(paymentMethod)) {
    return res.status(400).json({ error: "paymentMethod must be 'card', 'wallet', or 'membership'" });
  }

  // Client-computed fares are a convenience for showing a live estimate,
  // never a source of truth for what gets charged — a modified request
  // could otherwise claim any fareNaira it wants. Re-derive the add-on
  // portion server-side and reject anything that doesn't add up; full
  // distance-fare re-verification would need the same Distance Matrix
  // call server-side, which isn't wired up yet (see README §9).
  const SECURITY_ESCORT_PRICE = 100000;
  const FLEET_PRICE = { 2: 70000, 3: 100000 };
  const expectedAddOns = (securityEscort ? SECURITY_ESCORT_PRICE : 0) + (FLEET_PRICE[fleetSize] || 0);
  if (fareNaira < expectedAddOns) {
    return res.status(400).json({ error: "fareNaira is lower than the selected add-ons alone. Rejecting as inconsistent." });
  }

  // A membership rider doesn't pay per trip at all — that's the entire
  // point of the plan. Verified server-side against a real active
  // membership row, never just trusted because the client asked for it.
  if (paymentMethod === "membership") {
    const membership = await pool.query(
      `SELECT * FROM memberships WHERE user_id = $1 AND status = 'active' AND expires_at > now()
       AND plan_type IN ('individual_annual', 'corporate_delegate') LIMIT 1`,
      [req.user.id]
    );
    if (!membership.rows[0]) {
      return res.status(400).json({ error: "No active membership found for this account." });
    }
    const inserted = await pool.query(
      `INSERT INTO rides (rider_id, pickup_address, stops, flight_number, vehicle_type, fare_naira, payment_reference, booking_type, duration_days, agreed_cancellation_policy, distance_km, duration_min, security_escort, fleet_size, payment_status, emergency_contact_name, emergency_contact_phone, dash_cam_consent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, $10, $11, $12, $13, 'paid', $14, $15, $16) RETURNING *`,
      [req.user.id, pickupAddress, JSON.stringify(stops || []), flightNumber || null, vehicleType || null, fareNaira, null, bookingType, durationDays, distanceKm || null, durationMin || null, !!securityEscort, fleetSize || 0, emergencyContactName || null, emergencyContactPhone || null, !!dashCamConsent]
    );
    return res.status(201).json({ ride: withParsedStops(inserted.rows[0]) });
  }

  // Paying from wallet happens in the same DB transaction as creating the
  // ride, with a row lock on the user's balance — this is what stops two
  // simultaneous bookings from both reading "sufficient balance" and both
  // going through, overdrawing the wallet.
  if (paymentMethod === "wallet") {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const userResult = await client.query("SELECT wallet_balance_naira FROM users WHERE id = $1 FOR UPDATE", [req.user.id]);
      const balance = Number(userResult.rows[0].wallet_balance_naira);
      if (balance < fareNaira) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Insufficient wallet balance for this ride.", balanceNaira: balance, fareNaira });
      }

      const rideResult = await client.query(
        `INSERT INTO rides (rider_id, pickup_address, stops, flight_number, vehicle_type, fare_naira, payment_reference, booking_type, duration_days, agreed_cancellation_policy, distance_km, duration_min, security_escort, fleet_size, payment_status, emergency_contact_name, emergency_contact_phone, dash_cam_consent)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, $10, $11, $12, $13, 'paid', $14, $15, $16) RETURNING *`,
        [req.user.id, pickupAddress, JSON.stringify(stops || []), flightNumber || null, vehicleType || null, fareNaira, null, bookingType, durationDays, distanceKm || null, durationMin || null, !!securityEscort, fleetSize || 0, emergencyContactName || null, emergencyContactPhone || null, !!dashCamConsent]
      );
      const ride = rideResult.rows[0];

      const newBalanceResult = await client.query(
        "UPDATE users SET wallet_balance_naira = wallet_balance_naira - $1 WHERE id = $2 RETURNING wallet_balance_naira",
        [fareNaira, req.user.id]
      );
      const newBalance = Number(newBalanceResult.rows[0].wallet_balance_naira);

      await client.query(
        `INSERT INTO wallet_transactions (user_id, type, status, amount_naira, balance_after_naira, ride_id, description)
         VALUES ($1, 'ride_charge', 'completed', $2, $3, $4, $5)`,
        [req.user.id, -fareNaira, newBalance, ride.id, "Ride #" + ride.id + " (" + pickupAddress + ")"]
      );

      await client.query("COMMIT");
      return res.status(201).json({ ride: withParsedStops(ride) });
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("Wallet ride payment failed:", err.message);
      return res.status(500).json({ error: "Could not complete payment from wallet. Please try again." });
    } finally {
      client.release();
    }
  }

  const inserted = await pool.query(
    `INSERT INTO rides (rider_id, pickup_address, stops, flight_number, vehicle_type, fare_naira, payment_reference, booking_type, duration_days, agreed_cancellation_policy, distance_km, duration_min, security_escort, fleet_size, emergency_contact_name, emergency_contact_phone, dash_cam_consent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, $10, $11, $12, $13, $14, $15, $16) RETURNING *`,
    [req.user.id, pickupAddress, JSON.stringify(stops || []), flightNumber || null, vehicleType || null, fareNaira, paymentReference || null, bookingType, durationDays, distanceKm || null, durationMin || null, !!securityEscort, fleetSize || 0, emergencyContactName || null, emergencyContactPhone || null, !!dashCamConsent]
  );

  res.status(201).json({ ride: withParsedStops(inserted.rows[0]) });
});

// GET /api/rides/mine — the signed-in rider's ride history
router.get("/mine", requireAuth, async (req, res) => {
  const result = await pool.query("SELECT * FROM rides WHERE rider_id = $1 ORDER BY created_at DESC", [req.user.id]);
  res.json({ rides: result.rows.map(withParsedStops) });
});

// GET /api/rides/available — unassigned ride requests, for drivers to pick up
router.get("/available", requireAuth, requireRole("driver"), async (req, res) => {
  const result = await pool.query(
    `SELECT rides.*, users.name as rider_name, users.phone as rider_phone
     FROM rides
     JOIN users ON users.id = rides.rider_id
     WHERE rides.ride_status = 'requested' AND rides.driver_id IS NULL
     ORDER BY rides.created_at ASC
     LIMIT 20`
  );
  res.json({ rides: result.rows.map(withParsedStops) });
});

// POST /api/rides/:id/accept — a driver claims an unassigned ride.
router.post("/:id/accept", requireAuth, requireRole("driver"), async (req, res) => {
  const driver = await getDriverForUser(req.user.id);
  if (!driver) return res.status(404).json({ error: "Complete your driver profile first" });
  // Same gate as PATCH /api/drivers/status's "go online" check — accepting a
  // ride directly was a way around it, since nothing here confirmed the
  // driver had actually been approved by an admin.
  if (!driver.is_verified) {
    return res.status(403).json({ error: "Your account isn't verified yet. An admin needs to approve your driver profile before you can accept rides." });
  }

  const result = await pool.query(
    `UPDATE rides SET driver_id = $1, ride_status = 'accepted', updated_at = now()
     WHERE id = $2 AND ride_status = 'requested' AND driver_id IS NULL`,
    [driver.id, req.params.id]
  );

  if (result.rowCount === 0) {
    return res.status(409).json({ error: "This ride was just accepted by another driver" });
  }

  const ride = (
    await pool.query(
      `SELECT rides.*, users.name as rider_name, users.phone as rider_phone, users.push_token as rider_push_token
       FROM rides JOIN users ON users.id = rides.rider_id WHERE rides.id = $1`,
      [req.params.id]
    )
  ).rows[0];

  const driverUser = await pool.query("SELECT name FROM users WHERE id = $1", [req.user.id]);
  sendPushNotification(
    ride.rider_push_token,
    "Driver on the way",
    `${driverUser.rows[0]?.name || "Your driver"} accepted your ride and is heading your way.`,
    { rideId: ride.id, type: "ride_accepted" }
  ).catch(() => {});

  res.json({ ride: withParsedStops(ride) });
});

const STATUS_NOTIFICATION = {
  in_progress: { title: "Trip started", body: "Your trip is now in progress. Track it live in the app." },
  completed: { title: "Trip completed", body: "You've arrived! Tap to rate your driver." },
  cancelled: { title: "Trip cancelled", body: "Your driver cancelled this trip." },
};

// Valid ride-status transitions a driver can make via the route below.
// 'requested' isn't listed as a starting point — a ride only gets a
// driver_id (required to reach this route at all) once /accept has already
// moved it to 'accepted'. completed/cancelled are terminal: nothing can
// leave those states from here.
const VALID_STATUS_TRANSITIONS = {
  accepted: ["in_progress", "cancelled"],
  in_progress: ["completed", "cancelled"],
};

// PATCH /api/rides/:id/status — driver updates trip progress
router.patch("/:id/status", requireAuth, requireRole("driver"), async (req, res) => {
  const { status } = req.body;
  const allowed = ["in_progress", "completed", "cancelled"];
  if (!allowed.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${allowed.join(", ")}` });
  }

  const driver = await getDriverForUser(req.user.id);
  const existing = await pool.query("SELECT * FROM rides WHERE id = $1 AND driver_id = $2", [req.params.id, driver?.id]);
  if (!existing.rows[0]) return res.status(404).json({ error: "Ride not found or not assigned to you" });

  const currentStatus = existing.rows[0].ride_status;
  const nextAllowed = VALID_STATUS_TRANSITIONS[currentStatus] || [];
  if (!nextAllowed.includes(status)) {
    return res.status(400).json({ error: `Can't move a ride from '${currentStatus}' to '${status}'.` });
  }

  const updated = await pool.query(
    "UPDATE rides SET ride_status = $1, updated_at = now() WHERE id = $2 RETURNING *",
    [status, req.params.id]
  );
  const ride = updated.rows[0];

  const notification = STATUS_NOTIFICATION[status];
  if (notification) {
    const rider = await pool.query("SELECT push_token FROM users WHERE id = $1", [ride.rider_id]);
    sendPushNotification(rider.rows[0]?.push_token, notification.title, notification.body, {
      rideId: ride.id,
      type: `ride_${status}`,
    }).catch(() => {});
  }

  res.json({ ride: withParsedStops(ride) });
});

// GET /api/rides/driver/mine — this driver's accepted/active/completed rides
router.get("/driver/mine", requireAuth, requireRole("driver"), async (req, res) => {
  const driver = await getDriverForUser(req.user.id);
  if (!driver) return res.status(404).json({ error: "Complete your driver profile first" });

  const result = await pool.query(
    `SELECT rides.*, users.name as rider_name, users.phone as rider_phone
     FROM rides JOIN users ON users.id = rides.rider_id
     WHERE rides.driver_id = $1 ORDER BY rides.created_at DESC`,
    [driver.id]
  );
  res.json({ rides: result.rows.map(withParsedStops) });
});

// PATCH /api/rides/:id/payment — re-check this ride's own payment_reference
// against Paystack and sync payment_status if it's actually settled.
// Previously this trusted a client-supplied paymentStatus directly, which
// meant any rider could PATCH their own ride to "paid" for a free trip —
// nothing in either app actually calls this endpoint that way, so this
// closes the hole without touching any real flow. There's no client input
// here at all now beyond which ride to check: the reference used is always
// the one already stored on the ride, and "paid" is only ever set after a
// real Paystack lookup confirms success AND the amount matches the fare —
// same rule the webhook (routes/payments.js) enforces.
router.patch("/:id/payment", requireAuth, async (req, res) => {
  const existing = await pool.query("SELECT * FROM rides WHERE id = $1 AND rider_id = $2", [req.params.id, req.user.id]);
  const ride = existing.rows[0];
  if (!ride) return res.status(404).json({ error: "Ride not found" });

  if (ride.payment_status === "paid") {
    return res.json({ ride: withParsedStops(ride) });
  }
  if (!ride.payment_reference) {
    return res.status(400).json({ error: "This ride has no payment reference to verify." });
  }

  let verification;
  try {
    verification = await verifyPaystackTransaction(ride.payment_reference);
  } catch (err) {
    console.error("Paystack verify failed during payment sync:", err.response?.data || err.message);
    return res.status(502).json({ error: "Could not verify payment with Paystack. Please try again." });
  }

  const expectedNaira = Number(ride.fare_naira);
  if (!verification.success) {
    return res.status(400).json({ error: `Payment not yet confirmed (status: ${verification.status}).`, ride: withParsedStops(ride) });
  }
  if (Math.round(verification.amountNaira) !== Math.round(expectedNaira)) {
    console.error(`Payment amount mismatch for ride #${ride.id}: paid ₦${verification.amountNaira}, expected ₦${expectedNaira}`);
    return res.status(400).json({ error: "The amount paid doesn't match this ride's fare. Contact support." });
  }

  const updated = await pool.query(
    "UPDATE rides SET payment_status = 'paid', updated_at = now() WHERE id = $1 RETURNING *",
    [ride.id]
  );
  const newRide = updated.rows[0];

  const rider = await pool.query("SELECT email FROM users WHERE id = $1", [req.user.id]);
  if (rider.rows[0]) {
    sendBookingConfirmationEmail(rider.rows[0].email, newRide).catch((e) =>
      console.error("Booking confirmation email failed:", e.message)
    );
  }

  res.json({ ride: withParsedStops(newRide) });
});

// GET /api/rides/:id — full details for one ride, including the driver's
// current live location if one is assigned. Used by the rider's tracking
// screen to poll for progress. Only the rider who booked it or the
// assigned driver may view it.
router.get("/:id", requireAuth, async (req, res) => {
  const result = await pool.query(
    `SELECT rides.*,
            riders.name as rider_name, riders.phone as rider_phone,
            driver_users.name as driver_name, driver_users.phone as driver_phone,
            drivers.current_lat, drivers.current_lng, drivers.location_updated_at,
            drivers.rating as driver_rating, drivers.is_verified as driver_is_verified,
            vehicles.make_model, vehicles.plate_number, vehicles.vehicle_type as assigned_vehicle_type
     FROM rides
     JOIN users riders ON riders.id = rides.rider_id
     LEFT JOIN drivers ON drivers.id = rides.driver_id
     LEFT JOIN users driver_users ON driver_users.id = drivers.user_id
     LEFT JOIN vehicles ON vehicles.id = drivers.vehicle_id
     WHERE rides.id = $1`,
    [req.params.id]
  );
  const ride = result.rows[0];
  if (!ride) return res.status(404).json({ error: "Ride not found" });

  const driver = await getDriverForUser(req.user.id);
  const isRider = ride.rider_id === req.user.id;
  const isAssignedDriver = driver && ride.driver_id === driver.id;
  if (!isRider && !isAssignedDriver && req.user.role !== "admin") {
    return res.status(403).json({ error: "You don't have access to this ride" });
  }

  res.json({ ride: withParsedStops(ride) });
});

// POST /api/rides/:id/rate — the rider rates their driver after a
// completed trip ("Rate & Relax" on the website). One rating per trip;
// drivers.rating is recomputed as the average across all their rated
// completed trips whenever a new rating comes in.
// body: { rating: 1-5, comment? }
router.post("/:id/rate", requireAuth, async (req, res) => {
  const { rating, comment } = req.body;
  const numRating = Number(rating);
  if (!Number.isInteger(numRating) || numRating < 1 || numRating > 5) {
    return res.status(400).json({ error: "rating must be an integer from 1 to 5" });
  }

  const existing = await pool.query("SELECT * FROM rides WHERE id = $1 AND rider_id = $2", [req.params.id, req.user.id]);
  const ride = existing.rows[0];
  if (!ride) return res.status(404).json({ error: "Ride not found" });
  if (ride.ride_status !== "completed") {
    return res.status(400).json({ error: "You can only rate a completed trip" });
  }
  if (ride.rider_rating != null) {
    return res.status(400).json({ error: "You've already rated this trip" });
  }
  if (!ride.driver_id) {
    return res.status(400).json({ error: "This trip has no assigned driver to rate" });
  }

  const updated = await pool.query(
    "UPDATE rides SET rider_rating = $1, rider_rating_comment = $2, updated_at = now() WHERE id = $3 RETURNING *",
    [numRating, comment || null, ride.id]
  );

  await pool.query(
    `UPDATE drivers SET rating = (
       SELECT ROUND(AVG(rider_rating)::numeric, 2) FROM rides WHERE driver_id = drivers.id AND rider_rating IS NOT NULL
     ) WHERE id = $1`,
    [ride.driver_id]
  );

  res.json({ ride: withParsedStops(updated.rows[0]) });
});

// POST /api/rides/:id/panic — safety button. Either the rider who booked
// the ride OR the driver assigned to it can trigger this — the PRD for
// this feature is explicit that it's activated by "driver or passenger,"
// not just the rider. Intentionally simple and fast — this is a
// safety-critical path, not the place for complex validation.
router.post("/:id/panic", requireAuth, async (req, res) => {
  const { note } = req.body;
  const existing = await pool.query(
    `SELECT rides.* FROM rides
     LEFT JOIN drivers ON drivers.id = rides.driver_id
     WHERE rides.id = $1 AND (rides.rider_id = $2 OR drivers.user_id = $2)`,
    [req.params.id, req.user.id]
  );
  if (!existing.rows[0]) return res.status(404).json({ error: "Ride not found" });

  // "One trigger, full response" — panic bundles in activating the
  // listening device in the same write, rather than requiring a second
  // client call. listening_device_activated_at only gets set here if it
  // isn't already (one-way activation, never overwritten/reset).
  const updated = await pool.query(
    `UPDATE rides SET panic_triggered_at = now(), panic_notes = $1, updated_at = now(),
       listening_device_activated_at = COALESCE(listening_device_activated_at, now()),
       listening_device_via_panic = true
     WHERE id = $2 RETURNING *`,
    [note || null, req.params.id]
  );

  console.warn(`🚨 PANIC ALERT — ride #${req.params.id}, triggered by user ${req.user.email}`);
  // TODO before real launch: wire this to an actual alert — SMS/call to an
  // ops phone, a Slack webhook, or a push notification to the admin
  // dashboard. Right now it's logged server-side and visible in the admin
  // dashboard's ride list, but nothing pages anyone in real time.

  res.status(201).json({ ride: withParsedStops(updated.rows[0]) });
});

// POST /api/rides/:id/listening-device — standalone activation, independent
// of panic (either the rider or the driver on this ride can trigger it).
// Matches ridearrivo.com's real design: one-way only, no deactivate route.
// If panic already activated it, this is a harmless no-op (idempotent).
router.post("/:id/listening-device", requireAuth, async (req, res) => {
  const existing = await pool.query(
    `SELECT rides.* FROM rides
     LEFT JOIN drivers ON drivers.id = rides.driver_id
     WHERE rides.id = $1 AND (rides.rider_id = $2 OR drivers.user_id = $2)`,
    [req.params.id, req.user.id]
  );
  if (!existing.rows[0]) return res.status(404).json({ error: "Ride not found" });

  const updated = await pool.query(
    `UPDATE rides SET
       listening_device_activated_at = COALESCE(listening_device_activated_at, now()),
       updated_at = now()
     WHERE id = $1 RETURNING *`,
    [req.params.id]
  );

  res.status(201).json({ ride: withParsedStops(updated.rows[0]) });
});

// POST /api/rides/scan — a rider scans the driver's placard QR code. This
// is what actually starts live tracking: it confirms the rider is physically
// getting into the car that was actually assigned to them (not just
// trusting the app screen), then flips the ride to "in_progress".
// body: { scanToken }
router.post("/scan", requireAuth, async (req, res) => {
  const { scanToken } = req.body;
  if (!scanToken) return res.status(400).json({ error: "scanToken is required" });

  const driver = (
    await pool.query(
      `SELECT drivers.id, users.name as driver_name
       FROM drivers JOIN users ON users.id = drivers.user_id
       WHERE drivers.scan_token = $1`,
      [scanToken]
    )
  ).rows[0];
  if (!driver) return res.status(404).json({ error: "This QR code isn't recognized. Please ask your driver for help." });

  // Find THIS rider's currently-accepted ride with THIS specific driver —
  // scanning a random driver's placard should never start tracking on a
  // ride that isn't actually theirs.
  const ride = (
    await pool.query(
      `SELECT * FROM rides WHERE rider_id = $1 AND driver_id = $2 AND ride_status = 'accepted'
       ORDER BY created_at DESC LIMIT 1`,
      [req.user.id, driver.id]
    )
  ).rows[0];

  if (!ride) {
    return res.status(404).json({
      error: `No active booking found with ${driver.driver_name}. Make sure this is the driver assigned to your ride, and that it hasn't already started.`,
    });
  }

  const updated = await pool.query(
    `UPDATE rides SET ride_status = 'in_progress', tracking_started_at = now(), updated_at = now()
     WHERE id = $1 RETURNING *`,
    [ride.id]
  );

  res.json({ ride: withParsedStops(updated.rows[0]), driverName: driver.driver_name });
});

module.exports = router;
