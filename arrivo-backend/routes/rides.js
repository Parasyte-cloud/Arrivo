const express = require("express");
const { pool } = require("../db/db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { getDriverForUser } = require("./drivers");
const { sendBookingConfirmationEmail, sendDriverAssignedEmail } = require("../services/email");
const { sendPushNotification } = require("../services/pushNotifications");
const { sendWhatsAppMessage, driverAssignedMessage } = require("../services/whatsapp");
const { verifyPaystackTransaction } = require("./payments");
const { getDistanceDuration } = require("../services/googleMaps");
const { computeFare, findExcludedArea, MAX_FULL_DAY_COUNT, computeVehicleCount, computeOverageNaira } = require("../services/fare");
const { getNgnPerUsd } = require("../services/fx");
const { lookupFlightStatus } = require("./flights");

// Used only to re-confirm a rider can cover their trip after a flight-issue
// refund (see the flight_issue re-payment check in PATCH /:id/status below).
// This is NOT a standing floor required to book a ride at all — wallet is
// just one of the optional ways to pay (card or wallet), never mandatory.
// Priced in USD and converted at charge time (never hardcoded in naira) for
// the same reason LUXURY_SURCHARGE_USD in services/fare.js is.
const MIN_WALLET_BALANCE_USD = 100;

const router = express.Router();

function withParsedStops(ride) {
  return { ...ride, stops: JSON.parse(ride.stops || "[]") };
}

// POST /api/rides — create a new ride/booking (requires auth)
// body: { pickupAddress, stops?, flightNumber?, vehicleType, fareNaira,
//         paymentReference?, bookingType?, durationDays?, agreedCancellationPolicy,
//         scheduledPickupAt?, linkedRideId?,
//         pickupLat?, pickupLng?, destinationLat?, destinationLng? }
// bookingType: 'one_way' | 'dropoff' | 'full_day' | 'full_week' | 'full_month'
// 'dropoff' (Airport Drop-off — taking a departing rider TO the airport) is
// priced identically to 'one_way' (see services/fare.js: computeOneWayFare
// already picks whichever leg ISN'T the airport, so it works the same
// regardless of which direction the trip actually runs) — it's kept as its
// own bookingType rather than folded into 'one_way' purely so ride history,
// driver instructions, and reporting can tell the two apart.
// scheduledPickupAt is required for 'dropoff' (there's no flight-landing
// event to anchor timing the way an arrival pickup has) and optional
// otherwise. linkedRideId optionally pairs a drop-off with the arrival
// pickup ride it was booked alongside (round-trip-style), purely for
// display — it doesn't affect pricing or dispatch.
// pickupLat/Lng/destinationLat/Lng are required for one_way/dropoff
// bookings — that's what lets the fare actually be re-verified below
// instead of trusted from the client. Get these (and a live fareNaira to
// show the rider) from POST /api/rides/quote first.
router.post("/", requireAuth, async (req, res) => {
  const {
    pickupAddress, stops, flightNumber, vehicleType, paymentReference,
    bookingType = "one_way", durationDays = 1, agreedCancellationPolicy,
    distanceKm: clientDistanceKm, durationMin: clientDurationMin, securityEscort, fleetSize, paymentMethod = "card",
    emergencyContactName, emergencyContactPhone, dashCamConsent, luxury, payAtPickup,
    pickupLat, pickupLng, destinationLat, destinationLng,
    scheduledPickupAt, linkedRideId, adults = 1, children = 0, hoursPerDay,
  } = req.body;

  // Only meaningful (and only stored) for a single-day 'full_day' Chauffeur
  // booking — see the schema.sql comment on rides.included_hours_per_day for
  // why multi-day charters and one-way/drop-off trips don't get this at all.
  // Silently ignored (not an error) for every other booking shape, since
  // older app builds simply won't send it.
  let includedHoursPerDay = null;
  if (bookingType === "full_day" && Number(durationDays) === 1 && hoursPerDay != null) {
    const hours = Number(hoursPerDay);
    if (!Number.isFinite(hours) || hours <= 0 || hours > 24) {
      return res.status(400).json({ error: "hoursPerDay must be a number between 0 and 24." });
    }
    includedHoursPerDay = hours;
  }
  // Validated as whole numbers in a sane range BEFORE anything downstream
  // touches them — adults/children end up written straight into INTEGER
  // columns below, and an un-validated fractional value (e.g. 2.5) would
  // otherwise reach Postgres and throw an uncaught type error (a 500, not a
  // clean 400), while a huge or negative value could produce nonsensical
  // stored data even though computeVehicleCount's own MAX_AUTO_VEHICLE_COUNT
  // check only guards the derived passengerCount sum, not these individually.
  if (!Number.isInteger(Number(adults)) || Number(adults) < 1 || Number(adults) > 100) {
    return res.status(400).json({ error: "adults must be a whole number from 1 to 100." });
  }
  if (!Number.isInteger(Number(children)) || Number(children) < 0 || Number(children) > 100) {
    return res.status(400).json({ error: "children must be a whole number from 0 to 100." });
  }
  // Children take up a seat same as an adult for capacity purposes — see
  // computeVehicleCount in services/fare.js, which this passengerCount feeds
  // into. Recomputed from adults/children here rather than trusted as a
  // single client-sent number, same principle as every other fare input.
  const passengerCount = Math.max(1, Number(adults) + Number(children));

  if (!pickupAddress) {
    return res.status(400).json({ error: "pickupAddress is required" });
  }
  const allowedTypes = ["one_way", "dropoff", "full_day", "full_week", "full_month"];
  if (!allowedTypes.includes(bookingType)) {
    return res.status(400).json({ error: `bookingType must be one of: ${allowedTypes.join(", ")}` });
  }
  // "Full Day" can be booked for any number of consecutive days (3, 18, 78,
  // whatever the rider enters) — computeCharterFare multiplies the flat
  // day-rate by this. MAX_FULL_DAY_COUNT is just a generous server-side
  // sanity bound to reject garbage input, not a pricing/product ceiling
  // (see services/fare.js). Only meaningful for 'full_day'; ignored (and
  // not validated) for every other bookingType.
  if (bookingType === "full_day" && (!Number.isInteger(durationDays) || durationDays < 1 || durationDays > MAX_FULL_DAY_COUNT)) {
    return res.status(400).json({ error: `durationDays must be a whole number from 1 to ${MAX_FULL_DAY_COUNT} for a Full Day booking.` });
  }
  const isOneWayStyle = bookingType === "one_way" || bookingType === "dropoff";
  // One-way and drop-off fares are both priced off the non-airport leg (see
  // services/fare.js) — without a destination there's nothing to price
  // against.
  if (isOneWayStyle && !(Array.isArray(stops) && stops.length && stops[stops.length - 1])) {
    return res.status(400).json({ error: "A destination address is required for this booking type." });
  }
  if (!agreedCancellationPolicy) {
    return res.status(400).json({ error: "You must agree to the Cancellation & Refund Policy before booking" });
  }
  // Flight number is required for one-way airport PICKUPS specifically —
  // it's the only way to actually track an arriving rider's flight and show
  // a real ETA (see GET /api/flights/status and TrackingScreen). A
  // drop-off (departing rider) has no landing event to track, so it's
  // optional there — useful for reference/delay-awareness, not required.
  if (bookingType === "one_way" && !flightNumber) {
    return res.status(400).json({ error: "flightNumber is required for one-way bookings" });
  }
  // Drop-offs have no flight-landing event to anchor timing on, so the
  // rider must tell us exactly when they want picking up. Required only for
  // 'dropoff' — one-way pickups stay flight-number-driven, and charter
  // bookings collect their own date/time separately.
  let parsedScheduledPickupAt = null;
  if (bookingType === "dropoff" && !scheduledPickupAt) {
    return res.status(400).json({ error: "scheduledPickupAt is required for airport drop-off bookings." });
  }
  if (scheduledPickupAt) {
    parsedScheduledPickupAt = new Date(scheduledPickupAt);
    if (isNaN(parsedScheduledPickupAt.getTime())) {
      return res.status(400).json({ error: "scheduledPickupAt must be a valid date/time." });
    }
    if (parsedScheduledPickupAt.getTime() < Date.now()) {
      return res.status(400).json({ error: "scheduledPickupAt must be in the future." });
    }
  }
  // A linked ride (the arrival pickup this drop-off was booked alongside)
  // must actually belong to this same rider — otherwise a rider could tag
  // their booking onto a stranger's ride id.
  // If the rider said "keep the same driver and vehicle for my return trip"
  // at Rate & Relax on the linked ride (keep_same_driver_for_return), carry
  // that driver over as this new ride's preferred_driver_id — resolved
  // fresh here (not from a stale snapshot taken at rating time) so the
  // vehicle info reflects whatever that driver is actually assigned right
  // now. GET /api/rides/available filters this ride out of every other
  // driver's queue until the preference window elapses (see routes below),
  // and services/scheduler.js releases it + notifies the rider if the
  // preferred driver never claims it in time.
  let preferredDriverId = null;
  let preferredVehicleSnapshot = null;
  if (linkedRideId) {
    const linked = await pool.query("SELECT id, driver_id, keep_same_driver_for_return FROM rides WHERE id = $1 AND rider_id = $2", [linkedRideId, req.user.id]);
    if (!linked.rows[0]) {
      return res.status(400).json({ error: "linkedRideId must refer to one of your own rides." });
    }
    const linkedRide = linked.rows[0];
    if (linkedRide.keep_same_driver_for_return && linkedRide.driver_id) {
      const driverInfo = await pool.query(
        `SELECT drivers.id, vehicles.make_model, vehicles.plate_number
         FROM drivers LEFT JOIN vehicles ON vehicles.id = drivers.vehicle_id
         WHERE drivers.id = $1`,
        [linkedRide.driver_id]
      );
      if (driverInfo.rows[0]) {
        preferredDriverId = driverInfo.rows[0].id;
        preferredVehicleSnapshot = driverInfo.rows[0].make_model
          ? `${driverInfo.rows[0].make_model}${driverInfo.rows[0].plate_number ? " — " + driverInfo.rows[0].plate_number : ""}`
          : null;
      }
    }
  }
  if (fleetSize && ![0, 2, 3].includes(fleetSize)) {
    return res.status(400).json({ error: "fleetSize must be 0, 2, or 3" });
  }
  if (!["card", "wallet", "membership"].includes(paymentMethod)) {
    return res.status(400).json({ error: "paymentMethod must be 'card', 'wallet', or 'membership'" });
  }
  // "Reserve now, pay at pickup" has been removed as a product decision —
  // every ride is paid in full at booking, like a plane ticket, never at
  // the end of the trip. This guard rejects any client still trying to use
  // it (an old cached app build, for instance) with a clear message rather
  // than silently accepting it.
  if (payAtPickup) {
    return res.status(400).json({ error: "Reserve now, pay at pickup is no longer available. Please pay in full to book this ride." });
  }

  // Whatever fare the client showed the rider is a convenience for display
  // only — the real charge always comes from a fresh server-side
  // computation, never from a client-submitted number. This used to accept
  // a client fareNaira and reject the request if it didn't match the
  // server's own recomputation, but that meant a rider could be legitimately
  // rejected for stale-but-honest reasons entirely outside their control
  // (e.g. the FX rate — used for luxury/security-escort USD surcharges —
  // refreshing between quote and booking). Simplest fix: don't compare at
  // all, just always charge the fresh number.
  const ngnPerUsd = await getNgnPerUsd();
  const destinationAddress = Array.isArray(stops) && stops.length ? stops[stops.length - 1] : null;

  let distanceKm = clientDistanceKm ?? null;
  let durationMin = clientDurationMin ?? null;
  let fareNaira;
  let vehicleCount;
  // Recomputed independently of computeFare below (same passengerCount +
  // vehicleType inputs) purely so it can be stored on the ride and returned
  // to the rider — computeFare already applies this same number internally.
  try {
    vehicleCount = computeVehicleCount(passengerCount, vehicleType);
  } catch (err) {
    // Thrown when the group is bigger than MAX_AUTO_VEHICLE_COUNT vehicles
    // can realistically cover — a normal validation error, not a 500.
    return res.status(400).json({ error: err.message });
  }
  if (isOneWayStyle) {
    try {
      fareNaira = await computeFare({ bookingType, pickupAddress, destinationAddress, vehicleType, securityEscort, fleetSize, luxury, ngnPerUsd, passengerCount });
    } catch (err) {
      // Thrown by computeOneWayFare when pickup/destination matches a red
      // (excluded) zone — surfaced as a normal validation error, not a 500.
      return res.status(400).json({ error: err.message });
    }
    // Distance/duration are no longer used for pricing, but still useful
    // to store for the map/tracking screens — fetched best-effort here if
    // real coordinates were sent, but never blocks booking if this fails.
    if (pickupLat != null && pickupLng != null && destinationLat != null && destinationLng != null) {
      try {
        const distance = await getDistanceDuration(pickupLat, pickupLng, destinationLat, destinationLng);
        distanceKm = distance.distanceKm;
        durationMin = distance.durationMin;
      } catch (err) {
        console.error("Distance lookup failed during ride creation (informational only, not blocking):", err.message);
      }
    }
  } else {
    // Charter bookings (full_day/week/month) aren't distance- or
    // location-based — flat day-rate × duration, unaffected by any of the
    // above. durationDays only actually scales the fare for 'full_day' (see
    // services/fare.js computeCharterFare) — harmless to always pass it.
    // Chauffeur bookings don't currently collect a passenger count, so
    // passengerCount stays the default of 1 (vehicleCount 1) for those.
    try {
      fareNaira = await computeFare({ bookingType, vehicleType, securityEscort, fleetSize, luxury, ngnPerUsd, durationDays, passengerCount });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }

  // Best-effort capture of the flight's scheduled time AT BOOKING, purely
  // so services/scheduler.js can later tell "this flight got rescheduled"
  // (the live time has drifted a lot from this) apart from "it's always
  // been this time." Never blocks booking if the lookup fails or the key
  // isn't configured yet — same non-blocking pattern as the distance
  // lookup above.
  let originalFlightScheduledAt = null;
  if (flightNumber) {
    try {
      const flightInfo = await lookupFlightStatus(flightNumber);
      const anchor = bookingType === "dropoff" ? flightInfo?.departure?.scheduled : flightInfo?.arrival?.scheduled;
      if (anchor) originalFlightScheduledAt = new Date(anchor);
    } catch (err) {
      console.error("Flight lookup failed during ride creation (informational only, not blocking):", err.message);
    }
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
      `INSERT INTO rides (rider_id, pickup_address, stops, flight_number, vehicle_type, fare_naira, payment_reference, booking_type, duration_days, agreed_cancellation_policy, distance_km, duration_min, security_escort, fleet_size, payment_status, payment_method, pay_at_pickup, emergency_contact_name, emergency_contact_phone, dash_cam_consent, pickup_lat, pickup_lng, destination_lat, destination_lng, scheduled_pickup_at, linked_ride_id, preferred_driver_id, preferred_vehicle_snapshot, original_flight_scheduled_at, adults, children, vehicle_count, included_hours_per_day)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, $10, $11, $12, $13, 'paid', 'membership', false, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29) RETURNING *`,
      [req.user.id, pickupAddress, JSON.stringify(stops || []), flightNumber || null, vehicleType || null, fareNaira, null, bookingType, durationDays, distanceKm || null, durationMin || null, !!securityEscort, fleetSize || 0, emergencyContactName || null, emergencyContactPhone || null, !!dashCamConsent, pickupLat ?? null, pickupLng ?? null, destinationLat ?? null, destinationLng ?? null, parsedScheduledPickupAt, linkedRideId || null, preferredDriverId, preferredVehicleSnapshot, originalFlightScheduledAt, Number(adults) || 1, Number(children) || 0, vehicleCount, includedHoursPerDay]
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
        `INSERT INTO rides (rider_id, pickup_address, stops, flight_number, vehicle_type, fare_naira, payment_reference, booking_type, duration_days, agreed_cancellation_policy, distance_km, duration_min, security_escort, fleet_size, payment_status, payment_method, pay_at_pickup, emergency_contact_name, emergency_contact_phone, dash_cam_consent, pickup_lat, pickup_lng, destination_lat, destination_lng, scheduled_pickup_at, linked_ride_id, preferred_driver_id, preferred_vehicle_snapshot, original_flight_scheduled_at, adults, children, vehicle_count, included_hours_per_day)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, $10, $11, $12, $13, 'paid', 'wallet', false, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29) RETURNING *`,
        [req.user.id, pickupAddress, JSON.stringify(stops || []), flightNumber || null, vehicleType || null, fareNaira, null, bookingType, durationDays, distanceKm || null, durationMin || null, !!securityEscort, fleetSize || 0, emergencyContactName || null, emergencyContactPhone || null, !!dashCamConsent, pickupLat ?? null, pickupLng ?? null, destinationLat ?? null, destinationLng ?? null, parsedScheduledPickupAt, linkedRideId || null, preferredDriverId, preferredVehicleSnapshot, originalFlightScheduledAt, Number(adults) || 1, Number(children) || 0, vehicleCount, includedHoursPerDay]
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
    `INSERT INTO rides (rider_id, pickup_address, stops, flight_number, vehicle_type, fare_naira, payment_reference, booking_type, duration_days, agreed_cancellation_policy, distance_km, duration_min, security_escort, fleet_size, payment_method, pay_at_pickup, emergency_contact_name, emergency_contact_phone, dash_cam_consent, pickup_lat, pickup_lng, destination_lat, destination_lng, scheduled_pickup_at, linked_ride_id, preferred_driver_id, preferred_vehicle_snapshot, original_flight_scheduled_at, adults, children, vehicle_count, included_hours_per_day)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, $10, $11, $12, $13, 'card', false, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29) RETURNING *`,
    [req.user.id, pickupAddress, JSON.stringify(stops || []), flightNumber || null, vehicleType || null, fareNaira, paymentReference || null, bookingType, durationDays, distanceKm || null, durationMin || null, !!securityEscort, fleetSize || 0, emergencyContactName || null, emergencyContactPhone || null, !!dashCamConsent, pickupLat ?? null, pickupLng ?? null, destinationLat ?? null, destinationLng ?? null, parsedScheduledPickupAt, linkedRideId || null, preferredDriverId, preferredVehicleSnapshot, originalFlightScheduledAt, Number(adults) || 1, Number(children) || 0, vehicleCount, includedHoursPerDay]
  );

  res.status(201).json({ ride: withParsedStops(inserted.rows[0]) });
});

// POST /api/rides/quote — a live fare estimate, before any payment happens.
// Uses the exact same formula (services/fare.js) that ride creation above
// re-verifies against, so what a rider sees here is what they'll be
// charged. One-way fares are a flat per-location price (see
// services/fare.js) — deterministic, not distance-based — so the only way
// this quote differs from the eventual charge is if the 8pm–5am night rate
// boundary is crossed between quoting and booking.
// body: { bookingType?, vehicleType, securityEscort?, fleetSize?, luxury?,
//         pickupAddress?, destinationAddress?,
//         pickupLat?, pickupLng?, destinationLat?, destinationLng? }
// pickupAddress/destinationAddress are required for one-way (that's what
// prices it); lat/lng are optional and, if sent, are used only to return an
// informational distanceKm/durationMin for display — never for pricing.
// Returns fareUsd alongside fareNaira purely for display — naira is always
// the real, charged amount (see services/fx.js for why).
router.post("/quote", requireAuth, async (req, res) => {
  const {
    bookingType = "one_way", vehicleType, securityEscort, fleetSize, luxury,
    pickupAddress, destinationAddress, durationDays = 1,
    pickupLat, pickupLng, destinationLat, destinationLng,
    adults = 1, children = 0,
  } = req.body;

  if (!vehicleType) return res.status(400).json({ error: "vehicleType is required" });
  if (fleetSize && ![0, 2, 3].includes(fleetSize)) {
    return res.status(400).json({ error: "fleetSize must be 0, 2, or 3" });
  }
  if (bookingType === "full_day" && (!Number.isInteger(durationDays) || durationDays < 1 || durationDays > MAX_FULL_DAY_COUNT)) {
    return res.status(400).json({ error: `durationDays must be a whole number from 1 to ${MAX_FULL_DAY_COUNT} for a Full Day booking.` });
  }
  // See the identical validation + comment in POST / above.
  if (!Number.isInteger(Number(adults)) || Number(adults) < 1 || Number(adults) > 100) {
    return res.status(400).json({ error: "adults must be a whole number from 1 to 100." });
  }
  if (!Number.isInteger(Number(children)) || Number(children) < 0 || Number(children) > 100) {
    return res.status(400).json({ error: "children must be a whole number from 0 to 100." });
  }
  const passengerCount = Math.max(1, Number(adults) + Number(children));
  let vehicleCount;
  try {
    vehicleCount = computeVehicleCount(passengerCount, vehicleType);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const ngnPerUsd = await getNgnPerUsd();

  if (bookingType === "one_way" || bookingType === "dropoff") {
    if (!destinationAddress) {
      return res.status(400).json({ error: "destinationAddress is required to quote this fare" });
    }
    let fareNaira;
    try {
      fareNaira = await computeFare({ bookingType, pickupAddress, destinationAddress, vehicleType, securityEscort, fleetSize, luxury, ngnPerUsd, passengerCount });
    } catch (err) {
      // e.g. pickup/destination is in a red (excluded) zone — a normal
      // validation error, not a server failure.
      return res.status(400).json({ error: err.message });
    }

    let distanceKm = null;
    let durationMin = null;
    if (pickupLat != null && pickupLng != null && destinationLat != null && destinationLng != null) {
      try {
        const distance = await getDistanceDuration(pickupLat, pickupLng, destinationLat, destinationLng);
        distanceKm = distance.distanceKm;
        durationMin = distance.durationMin;
      } catch (err) {
        console.error("Distance lookup failed during quote (informational only, not blocking):", err.message);
      }
    }
    return res.json({ fareNaira, fareUsd: fareNaira / ngnPerUsd, ngnPerUsd, distanceKm, durationMin, vehicleCount });
  }

  const allowedCharterTypes = ["full_day", "full_week", "full_month"];
  if (!allowedCharterTypes.includes(bookingType)) {
    return res.status(400).json({ error: `bookingType must be one of: one_way, dropoff, ${allowedCharterTypes.join(", ")}` });
  }
  let fareNaira;
  try {
    fareNaira = await computeFare({ bookingType, vehicleType, securityEscort, fleetSize, luxury, ngnPerUsd, durationDays, passengerCount });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  res.json({ fareNaira, fareUsd: fareNaira / ngnPerUsd, ngnPerUsd, distanceKm: null, durationMin: null, vehicleCount });
});

// GET /api/rides/fx-rate — the current naira-per-dollar rate, for apps to
// show a $ estimate next to a naira fare (formatting only — see
// services/fx.js for why naira stays the real number everywhere else).
// Separate from /wallet-minimum below since most screens just need the
// rate, not a wallet-balance lookup too.
router.get("/fx-rate", requireAuth, async (req, res) => {
  const ngnPerUsd = await getNgnPerUsd();
  res.json({ ngnPerUsd });
});

// GET /api/rides/wallet-minimum — lets the app proactively check whether
// this rider clears the standing wallet-balance floor (see
// MIN_WALLET_BALANCE_USD above) BEFORE they get to checkout, so they can be
// prompted to top up early rather than hitting a rejection from POST /
// after filling out an entire booking. POST / above re-checks this for
// real at booking time regardless of what this endpoint said.
router.get("/wallet-minimum", requireAuth, async (req, res) => {
  const ngnPerUsd = await getNgnPerUsd();
  const minWalletBalanceNaira = MIN_WALLET_BALANCE_USD * ngnPerUsd;
  const walletRow = await pool.query("SELECT wallet_balance_naira FROM users WHERE id = $1", [req.user.id]);
  const walletBalanceNaira = Number(walletRow.rows[0]?.wallet_balance_naira || 0);
  res.json({
    walletBalanceNaira,
    minWalletBalanceNaira,
    meetsMinimum: walletBalanceNaira >= minWalletBalanceNaira,
    ngnPerUsd,
  });
});

// GET /api/rides/mine — the signed-in rider's ride history
router.get("/mine", requireAuth, async (req, res) => {
  const result = await pool.query("SELECT * FROM rides WHERE rider_id = $1 ORDER BY created_at DESC", [req.user.id]);
  res.json({ rides: result.rows.map(withParsedStops) });
});

// GET /api/rides/available — unassigned ride requests, for drivers to pick up
// GET /api/rides/available — the driver's claim queue. Two visibility
// rules layered on top of the plain "unassigned + requested" filter:
//
// 1. Driver continuity ("keep the same driver for my return trip", set at
//    Rate & Relax — see keep_same_driver_for_return / preferred_driver_id):
//    a ride with an active preferred_driver_id is hidden from every OTHER
//    driver's queue entirely. It only shows up for everyone once
//    services/scheduler.js clears that column after the claim window
//    elapses unaccepted (and at that point it also notifies the rider why
//    their driver changed).
// 2. Scheduled drop-offs booked far in advance shouldn't sit in every
//    driver's queue for days before there's anything useful to do about
//    them — visible immediately only to a preferred driver (if any),
//    otherwise opened up to the general queue starting 5 hours before
//    scheduled_pickup_at (the same threshold as the first reminder push).
//    Rides with no scheduled_pickup_at (immediate one-way pickups, charter
//    bookings) are unaffected — always visible right away, same as before.
router.get("/available", requireAuth, requireRole("driver"), async (req, res) => {
  const driver = await getDriverForUser(req.user.id);
  const driverId = driver?.id || null;

  const result = await pool.query(
    `SELECT rides.*, users.name as rider_name, users.phone as rider_phone,
            (rides.preferred_driver_id = $1) as is_preferred_for_you
     FROM rides
     JOIN users ON users.id = rides.rider_id
     WHERE rides.ride_status = 'requested' AND rides.driver_id IS NULL
       AND (rides.preferred_driver_id IS NULL OR rides.preferred_driver_id = $1)
       AND (
         rides.scheduled_pickup_at IS NULL
         OR rides.preferred_driver_id = $1
         OR rides.scheduled_pickup_at <= now() + interval '5 hours'
       )
     ORDER BY rides.created_at ASC
     LIMIT 20`,
    [driverId]
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

  // Defense in depth — GET /available already hides a preferred-driver ride
  // from everyone else's queue, but this stops a direct API call (an old
  // cached ride id, for instance) from bypassing that.
  const result = await pool.query(
    `UPDATE rides SET driver_id = $1, ride_status = 'accepted', updated_at = now()
     WHERE id = $2 AND ride_status = 'requested' AND driver_id IS NULL
       AND (preferred_driver_id IS NULL OR preferred_driver_id = $1)`,
    [driver.id, req.params.id]
  );

  if (result.rowCount === 0) {
    return res.status(409).json({ error: "This ride was just accepted by another driver" });
  }

  const ride = (
    await pool.query(
      `SELECT rides.*, users.name as rider_name, users.phone as rider_phone,
              users.push_token as rider_push_token, users.email as rider_email,
              users.whatsapp_number as rider_whatsapp_number
       FROM rides JOIN users ON users.id = rides.rider_id WHERE rides.id = $1`,
      [req.params.id]
    )
  ).rows[0];

  const driverUser = await pool.query("SELECT name FROM users WHERE id = $1", [req.user.id]);
  const driverName = driverUser.rows[0]?.name || "Your driver";
  sendPushNotification(
    ride.rider_push_token,
    "Driver on the way",
    `${driverName} accepted your ride and is heading your way.`,
    { rideId: ride.id, type: "ride_accepted" }
  ).catch(() => {});

  // "It should have those [driver/vehicle] information and also it should
  // be sent to their WhatsApp number and email" — sent in parallel with the
  // push above, fire-and-forget same as every other notification in this
  // file (a slow/failed WhatsApp or email send should never hold up the
  // accept response the driver app is waiting on).
  const vehicleInfo = await pool.query(
    `SELECT vehicles.make_model, vehicles.plate_number FROM vehicles WHERE vehicles.id = (SELECT vehicle_id FROM drivers WHERE id = $1)`,
    [driver.id]
  );
  const vehicleLabel = vehicleInfo.rows[0]?.make_model
    ? `${vehicleInfo.rows[0].make_model}${vehicleInfo.rows[0].plate_number ? " — " + vehicleInfo.rows[0].plate_number : ""}`
    : null;
  if (ride.rider_whatsapp_number) {
    sendWhatsAppMessage(ride.rider_whatsapp_number, driverAssignedMessage(ride, driverName, vehicleLabel)).catch(() => {});
  }
  if (ride.rider_email) {
    sendDriverAssignedEmail(ride.rider_email, ride, driverName, vehicleLabel).catch(() => {});
  }

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

  // "Reserve now, pay at pickup" was removed as a product decision — every
  // ride is paid in full at booking now, and POST / rejects any new
  // attempt to create a pay-at-pickup ride. This guard is left in place as
  // a safety net for any ride that was already reserved-unpaid before that
  // change shipped: it stops a driver's "Start Trip" from starting a trip
  // the rider hasn't actually paid for yet, same as it always did. It
  // should never trigger for any ride created after this deployment.
  if (
    status === "in_progress" &&
    existing.rows[0].pay_at_pickup &&
    existing.rows[0].payment_method === "wallet" &&
    existing.rows[0].payment_status !== "paid"
  ) {
    return res.status(400).json({
      error: "This rider reserved their ride and hasn't paid yet. Ask them to scan your QR placard to confirm pickup and complete payment before starting the trip.",
    });
  }

  // Flight cancelled/rescheduled (flight_issue set by services/scheduler.js)
  // — the original fare was already refunded back to the rider's wallet the
  // moment the issue was detected (see the scheduler), so payment_status
  // reads 'pending_reconfirmation' rather than 'paid' from that point on.
  // Before the trip can actually start again, re-apply the same
  // $100-equivalent standing-wallet-balance rule POST / already enforces at
  // booking (MIN_WALLET_BALANCE_USD above) — the rider's circumstances have
  // changed since they last confirmed they could cover this trip, so this
  // re-confirms it rather than assuming it still holds.
  if (status === "in_progress" && existing.rows[0].flight_issue && existing.rows[0].payment_status !== "paid") {
    const ngnPerUsd = await getNgnPerUsd();
    const minBalanceNaira = MIN_WALLET_BALANCE_USD * ngnPerUsd;
    const walletRow = await pool.query("SELECT wallet_balance_naira FROM users WHERE id = $1", [existing.rows[0].rider_id]);
    const currentWalletBalance = Number(walletRow.rows[0]?.wallet_balance_naira || 0);
    if (currentWalletBalance < minBalanceNaira) {
      return res.status(400).json({
        error: `This rider's flight was ${existing.rows[0].flight_issue}, and they need at least ₦${Math.round(minBalanceNaira).toLocaleString()} (~$${MIN_WALLET_BALANCE_USD}) in their wallet before this trip can start. Ask them to top up in the app.`,
        walletBalanceNaira: currentWalletBalance,
        minWalletBalanceNaira: minBalanceNaira,
      });
    }
  }

  const updated = await pool.query(
    `UPDATE rides SET ride_status = $1, updated_at = now(),
       completed_at = CASE WHEN $1 = 'completed' THEN now() ELSE completed_at END
     WHERE id = $2 RETURNING *`,
    [status, req.params.id]
  );
  let ride = updated.rows[0];

  // Chauffeur time-overage — deliberately scoped to single-day 'full_day'
  // bookings only (see the schema.sql comment on included_hours_per_day for
  // why). tracking_started_at is set when the driver tapped Start Trip;
  // completed_at was just set above. Elapsed wall-clock time between the two
  // is a meaningful signal here specifically because it's a single
  // continuous engagement, not a multi-day booking with overnight gaps where
  // raw elapsed time would be meaningless. Silently does nothing if
  // included_hours_per_day was never set (an older booking, or a rider who
  // didn't have this field yet) — never invents an overage from thin air.
  if (
    status === "completed" &&
    ride.booking_type === "full_day" &&
    Number(ride.duration_days) === 1 &&
    ride.included_hours_per_day &&
    ride.tracking_started_at
  ) {
    const elapsedHours = (new Date(ride.completed_at).getTime() - new Date(ride.tracking_started_at).getTime()) / (1000 * 60 * 60);
    const overageNaira = computeOverageNaira({
      vehicleType: ride.vehicle_type,
      includedHoursPerDay: Number(ride.included_hours_per_day),
      elapsedHours,
      fareNaira: Number(ride.fare_naira),
    });
    if (overageNaira > 0) {
      const overageUpdate = await pool.query(
        "UPDATE rides SET overage_naira = $1, updated_at = now() WHERE id = $2 RETURNING *",
        [overageNaira, ride.id]
      );
      ride = overageUpdate.rows[0];
    }
  }

  // Charge-at-drop-off for flight-issue rides: the fare wasn't collected
  // upfront this time (it was refunded when the issue was flagged), so
  // collect it now, at completion, instead — same row-locked wallet-debit
  // pattern as the wallet fare path in POST / and the wallet tip path
  // below. If the wallet balance somehow dropped below the fare between
  // Start Trip and now, this fails safe (ride stays 'completed' — the trip
  // already happened — but payment_status stays unpaid, flagged here for
  // admin follow-up rather than silently writing off the fare).
  if (status === "completed" && ride.flight_issue && ride.payment_status !== "paid") {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const userResult = await client.query("SELECT wallet_balance_naira FROM users WHERE id = $1 FOR UPDATE", [ride.rider_id]);
      const balance = Number(userResult.rows[0].wallet_balance_naira);
      if (balance >= Number(ride.fare_naira)) {
        const newBalanceResult = await client.query(
          "UPDATE users SET wallet_balance_naira = wallet_balance_naira - $1 WHERE id = $2 RETURNING wallet_balance_naira",
          [ride.fare_naira, ride.rider_id]
        );
        const newBalance = Number(newBalanceResult.rows[0].wallet_balance_naira);
        const rideUpdate = await client.query(
          "UPDATE rides SET payment_status = 'paid', payment_method = 'wallet', updated_at = now() WHERE id = $1 RETURNING *",
          [ride.id]
        );
        ride = rideUpdate.rows[0];
        await client.query(
          `INSERT INTO wallet_transactions (user_id, type, status, amount_naira, balance_after_naira, ride_id, description)
           VALUES ($1, 'ride_charge', 'completed', $2, $3, $4, $5)`,
          [ride.rider_id, -ride.fare_naira, newBalance, ride.id, "Ride #" + ride.id + " (charged at drop-off after flight change)"]
        );
        await client.query("COMMIT");
      } else {
        await client.query("ROLLBACK");
        console.error(`[flight-issue] Ride #${ride.id} completed but rider's wallet balance (₦${balance}) is below the fare (₦${ride.fare_naira}) — left unpaid for admin follow-up.`);
      }
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("Charge-at-dropoff failed:", err.message);
    } finally {
      client.release();
    }
  }

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
// body: { rating: 1-5, comment?, keepSameDriver? }
// keepSameDriver: "same driver, same vehicle, unless they say otherwise" —
// if true, this ride's driver + vehicle become the preferred pairing for
// whatever return trip gets linked to this one later (see
// keep_same_driver_for_return in db/schema.sql, and the linkedRideId
// handling in POST / below, which is what actually copies this over onto
// the new dropoff ride at creation time).
router.post("/:id/rate", requireAuth, async (req, res) => {
  const { rating, comment, keepSameDriver } = req.body;
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
    "UPDATE rides SET rider_rating = $1, rider_rating_comment = $2, keep_same_driver_for_return = $3, updated_at = now() WHERE id = $4 RETURNING *",
    [numRating, comment || null, !!keepSameDriver, ride.id]
  );

  await pool.query(
    `UPDATE drivers SET rating = (
       SELECT ROUND(AVG(rider_rating)::numeric, 2) FROM rides WHERE driver_id = drivers.id AND rider_rating IS NOT NULL
     ) WHERE id = $1`,
    [ride.driver_id]
  );

  res.json({ ride: withParsedStops(updated.rows[0]) });
});

// POST /api/rides/:id/tip — optional gratuity for the driver, after a
// completed trip (shown alongside the rating prompt in the apps). Riders
// never tip in cash — this goes through the same rails as the fare itself:
// an immediate wallet debit, or a fresh card charge that gets independently
// verified against Paystack, same as every other payment in this file.
// One tip per ride.
// body: { amountNaira, paymentMethod: 'wallet' | 'card', paymentReference? }
// paymentReference is required (and independently verified) for card tips.
router.post("/:id/tip", requireAuth, async (req, res) => {
  const { amountNaira, paymentMethod, paymentReference } = req.body;

  if (!(amountNaira > 0)) {
    return res.status(400).json({ error: "amountNaira must be a positive number" });
  }
  if (!["wallet", "card"].includes(paymentMethod)) {
    return res.status(400).json({ error: "paymentMethod must be 'wallet' or 'card'" });
  }

  const existing = await pool.query("SELECT * FROM rides WHERE id = $1 AND rider_id = $2", [req.params.id, req.user.id]);
  const ride = existing.rows[0];
  if (!ride) return res.status(404).json({ error: "Ride not found" });
  if (ride.ride_status !== "completed") {
    return res.status(400).json({ error: "You can only tip after the ride is completed." });
  }
  if (!ride.driver_id) {
    return res.status(400).json({ error: "This trip has no assigned driver to tip" });
  }
  if (Number(ride.tip_naira) > 0) {
    return res.status(400).json({ error: "You've already tipped this ride." });
  }
  // Loose sanity cap — catches an obvious fat-finger (an accidental extra
  // zero) without being restrictive about genuinely generous tipping.
  if (amountNaira > Number(ride.fare_naira) * 5) {
    return res.status(400).json({ error: "That tip looks unusually large for this fare. Please double-check the amount." });
  }

  if (paymentMethod === "card") {
    if (!paymentReference) {
      return res.status(400).json({ error: "paymentReference is required for a card tip" });
    }
    let verification;
    try {
      verification = await verifyPaystackTransaction(paymentReference);
    } catch (err) {
      console.error("Tip payment verification failed:", err.response?.data || err.message);
      return res.status(502).json({ error: "Couldn't verify the tip payment. Please try again." });
    }
    if (!verification.success || Math.round(verification.amountNaira) !== Math.round(amountNaira)) {
      return res.status(400).json({ error: "Tip payment could not be verified." });
    }
    const updated = await pool.query(
      `UPDATE rides SET tip_naira = $1, tip_payment_method = 'card', tip_payment_reference = $2, updated_at = now() WHERE id = $3 RETURNING *`,
      [amountNaira, paymentReference, ride.id]
    );
    return res.json({ ride: withParsedStops(updated.rows[0]) });
  }

  // Wallet tip — same atomic, row-locked pattern as a wallet-paid fare, so
  // two near-simultaneous requests can't double-charge or read a stale
  // balance.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const userResult = await client.query("SELECT wallet_balance_naira FROM users WHERE id = $1 FOR UPDATE", [req.user.id]);
    const balance = Number(userResult.rows[0].wallet_balance_naira);
    if (balance < amountNaira) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Insufficient wallet balance for this tip.", balanceNaira: balance });
    }

    const rideUpdate = await client.query(
      `UPDATE rides SET tip_naira = $1, tip_payment_method = 'wallet', updated_at = now() WHERE id = $2 RETURNING *`,
      [amountNaira, ride.id]
    );

    const newBalanceResult = await client.query(
      "UPDATE users SET wallet_balance_naira = wallet_balance_naira - $1 WHERE id = $2 RETURNING wallet_balance_naira",
      [amountNaira, req.user.id]
    );
    const newBalance = Number(newBalanceResult.rows[0].wallet_balance_naira);

    await client.query(
      `INSERT INTO wallet_transactions (user_id, type, status, amount_naira, balance_after_naira, ride_id, description)
       VALUES ($1, 'tip', 'completed', $2, $3, $4, $5)`,
      [req.user.id, -amountNaira, newBalance, ride.id, "Tip for Ride #" + ride.id]
    );

    await client.query("COMMIT");
    return res.json({ ride: withParsedStops(rideUpdate.rows[0]) });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Wallet tip failed:", err.message);
    return res.status(500).json({ error: "Could not complete tip payment. Please try again." });
  } finally {
    client.release();
  }
});

// POST /api/rides/:id/overage-charge — pays off an automatically-computed
// Chauffeur time-overage charge (see PATCH /:id/status above, where
// overage_naira gets set at trip completion for a single-day 'full_day'
// booking that ran longer than the hours the rider selected at booking).
// Modeled closely on POST /:id/tip just above: same wallet-debit-or-fresh-
// card-charge rails, riders never pay this in cash. Unlike a tip, the
// amount is NOT rider-chosen — it's whatever the system already computed
// and stored on the ride, so this endpoint only accepts a payment method.
// body: { paymentMethod: 'wallet' | 'card', paymentReference? }
router.post("/:id/overage-charge", requireAuth, async (req, res) => {
  const { paymentMethod, paymentReference } = req.body;

  if (!["wallet", "card"].includes(paymentMethod)) {
    return res.status(400).json({ error: "paymentMethod must be 'wallet' or 'card'" });
  }

  const existing = await pool.query("SELECT * FROM rides WHERE id = $1 AND rider_id = $2", [req.params.id, req.user.id]);
  const ride = existing.rows[0];
  if (!ride) return res.status(404).json({ error: "Ride not found" });
  if (ride.ride_status !== "completed") {
    return res.status(400).json({ error: "This ride isn't completed yet." });
  }
  const overageNaira = Number(ride.overage_naira);
  if (!(overageNaira > 0)) {
    return res.status(400).json({ error: "There's no overage charge on this ride." });
  }
  if (ride.overage_payment_reference || ride.overage_payment_method) {
    return res.status(400).json({ error: "This overage charge has already been paid." });
  }

  if (paymentMethod === "card") {
    if (!paymentReference) {
      return res.status(400).json({ error: "paymentReference is required for a card payment" });
    }
    let verification;
    try {
      verification = await verifyPaystackTransaction(paymentReference);
    } catch (err) {
      console.error("Overage charge payment verification failed:", err.response?.data || err.message);
      return res.status(502).json({ error: "Couldn't verify the payment. Please try again." });
    }
    if (!verification.success || Math.round(verification.amountNaira) !== Math.round(overageNaira)) {
      return res.status(400).json({ error: "Payment could not be verified." });
    }
    const updated = await pool.query(
      `UPDATE rides SET overage_payment_method = 'card', overage_payment_reference = $1, updated_at = now() WHERE id = $2 RETURNING *`,
      [paymentReference, ride.id]
    );
    return res.json({ ride: withParsedStops(updated.rows[0]) });
  }

  // Wallet — same atomic, row-locked pattern as every other wallet debit in
  // this file.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const userResult = await client.query("SELECT wallet_balance_naira FROM users WHERE id = $1 FOR UPDATE", [req.user.id]);
    const balance = Number(userResult.rows[0].wallet_balance_naira);
    if (balance < overageNaira) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Insufficient wallet balance for this charge.", balanceNaira: balance, overageNaira });
    }

    const rideUpdate = await client.query(
      `UPDATE rides SET overage_payment_method = 'wallet', overage_payment_reference = NULL, updated_at = now() WHERE id = $1 RETURNING *`,
      [ride.id]
    );

    const newBalanceResult = await client.query(
      "UPDATE users SET wallet_balance_naira = wallet_balance_naira - $1 WHERE id = $2 RETURNING wallet_balance_naira",
      [overageNaira, req.user.id]
    );
    const newBalance = Number(newBalanceResult.rows[0].wallet_balance_naira);

    await client.query(
      `INSERT INTO wallet_transactions (user_id, type, status, amount_naira, balance_after_naira, ride_id, description)
       VALUES ($1, 'overage', 'completed', $2, $3, $4, $5)`,
      [req.user.id, -overageNaira, newBalance, ride.id, "Time overage charge for Ride #" + ride.id]
    );

    await client.query("COMMIT");
    return res.json({ ride: withParsedStops(rideUpdate.rows[0]) });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Wallet overage charge failed:", err.message);
    return res.status(500).json({ error: "Could not complete payment. Please try again." });
  } finally {
    client.release();
  }
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

  // "Reserve now, pay at pickup" was removed as a product decision — every
  // ride is paid in full at booking now, so no ride created going forward
  // can ever reach this branch. Left in place only as a safety net so any
  // ride that was already reserved-unpaid before that change shipped still
  // gets charged correctly at scan time (atomically, with a row lock so two
  // near-simultaneous scans can't double-charge or both succeed off a
  // stale balance read); the scan fails with a clear error and the ride
  // stays 'accepted' if the wallet can't cover it.
  if (ride.pay_at_pickup && ride.payment_method === "wallet" && ride.payment_status !== "paid") {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const userResult = await client.query("SELECT wallet_balance_naira FROM users WHERE id = $1 FOR UPDATE", [req.user.id]);
      const balance = Number(userResult.rows[0].wallet_balance_naira);
      const fareNaira = Number(ride.fare_naira);
      if (balance < fareNaira) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: `Your wallet balance (₦${Math.round(balance).toLocaleString()}) isn't enough to cover this ride's ₦${Math.round(fareNaira).toLocaleString()} fare. Please top up your wallet and scan again.`,
          balanceNaira: balance,
          fareNaira,
        });
      }

      const newBalanceResult = await client.query(
        "UPDATE users SET wallet_balance_naira = wallet_balance_naira - $1 WHERE id = $2 RETURNING wallet_balance_naira",
        [fareNaira, req.user.id]
      );
      const newBalance = Number(newBalanceResult.rows[0].wallet_balance_naira);

      await client.query(
        `INSERT INTO wallet_transactions (user_id, type, status, amount_naira, balance_after_naira, ride_id, description)
         VALUES ($1, 'ride_charge', 'completed', $2, $3, $4, $5)`,
        [req.user.id, -fareNaira, newBalance, ride.id, "Ride #" + ride.id + " (" + ride.pickup_address + ")"]
      );

      await client.query("UPDATE rides SET payment_status = 'paid' WHERE id = $1", [ride.id]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("Pay-at-pickup wallet charge failed:", err.message);
      return res.status(500).json({ error: "Could not charge your wallet for this ride. Please try again." });
    } finally {
      client.release();
    }
  }

  const updated = await pool.query(
    `UPDATE rides SET ride_status = 'in_progress', tracking_started_at = now(), updated_at = now()
     WHERE id = $1 RETURNING *`,
    [ride.id]
  );

  res.json({ ride: withParsedStops(updated.rows[0]), driverName: driver.driver_name });
});

module.exports = router;
