// Background sweep — runs every few minutes, no new npm dependency (plain
// setInterval rather than node-cron), so there's nothing extra to install
// before this can ship. Three independent jobs, each looking at a
// different slice of "rides that need something to happen automatically":
//
// 1. Pickup/drop-off reminders — push notifications at 5h/3h/1h/now before
//    a ride's pickup time, to both rider and (if assigned) driver. Drivers
//    get an extra "be there 30 minutes early" instruction on the 1h/now
//    pushes — this project doesn't have live GPS geofencing to actually
//    enforce that, so it's a strong reminder rather than a hard block; see
//    the wrap-up notes for why that's a deliberate scope decision for now.
// 2. Flight cancellation/reschedule detection — for 'dropoff' (return-leg)
//    bookings with a tracked flight number, refunds the original fare to
//    the rider's wallet and requires re-confirming the $100-equivalent
//    standing balance before the trip can start again (see routes/rides.js
//    PATCH /:id/status), charging the actual fare at drop-off instead.
// 3. Preferred-driver claim-window expiry — "keep the same driver for my
//    return trip" (set at Rate & Relax) only holds a ride exclusively for
//    that one driver until 3 hours before pickup; if they haven't accepted
//    by then, the ride opens to every driver and the rider gets a
//    "your driver changed, here's why" notice instead of a silent surprise.
//
// All three are best-effort: a single ride failing to process (a bad
// flight number, a transient DB hiccup) is caught and logged, never allowed
// to crash the sweep or block any other ride in the same pass.

const { pool } = require("../db/db");
const { sendPushNotification } = require("./pushNotifications");
const { sendWhatsAppMessage, flightIssueMessage, driverChangedMessage } = require("./whatsapp");
const { sendFlightIssueEmail, sendDriverChangedEmail } = require("./email");
const { lookupFlightStatus } = require("../routes/flights");

const SWEEP_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes

// Ordered largest-to-smallest so a sweep that missed a window (server was
// briefly down, etc.) still sends every reminder it should have, oldest
// first, in one pass rather than skipping straight to the latest one.
const REMINDER_THRESHOLDS = [
  { hours: 5, column: "reminder_5h_sent", label: "5 hours" },
  { hours: 3, column: "reminder_3h_sent", label: "3 hours" },
  { hours: 1, column: "reminder_1h_sent", label: "1 hour" },
  { hours: 0, column: "reminder_now_sent", label: "now" },
];

function riderReminderCopy(label, ride) {
  const tripWord = ride.booking_type === "dropoff" ? "airport drop-off" : "airport pickup";
  if (label === "now") return `It's time — your ${tripWord} is starting now.`;
  return `Reminder: your ${tripWord} is in ${label}.`;
}

function driverReminderCopy(label, ride) {
  const tripWord = ride.booking_type === "dropoff" ? "drop-off" : "pickup";
  const base = `Reminder: your ${tripWord} for ${ride.pickup_address} is in ${label === "now" ? "now" : label}.`;
  // 30-minutes-early instruction on the two closest thresholds — that's
  // the point past which it actually matters for the driver's own timing.
  if (label === "1 hour" || label === "now") {
    return `${base} Please be on-site at least 30 minutes ahead of the scheduled time.`;
  }
  return base;
}

async function sendReminder(ride, label, driverPushToken) {
  if (ride.rider_push_token) {
    sendPushNotification(ride.rider_push_token, "RideArrivo reminder", riderReminderCopy(label, ride), {
      rideId: ride.id,
      type: "pickup_reminder",
    }).catch(() => {});
  }
  if (driverPushToken) {
    sendPushNotification(driverPushToken, "Upcoming trip", driverReminderCopy(label, ride), {
      rideId: ride.id,
      type: "pickup_reminder_driver",
    }).catch(() => {});
  }
}

// Job 1 — pickup/drop-off reminders.
async function sweepReminders() {
  // 'dropoff' rides are anchored on the rider-supplied scheduled_pickup_at.
  // 'one_way' rides have no such fixed time — they're driven by the
  // arriving flight's live ETA — so a flight lookup is needed per ride
  // rather than a single SQL WHERE clause covering both cases.
  const dropoffRides = await pool.query(
    `SELECT rides.*, users.push_token as rider_push_token, driver_users.push_token as driver_push_token
     FROM rides
     JOIN users ON users.id = rides.rider_id
     LEFT JOIN drivers ON drivers.id = rides.driver_id
     LEFT JOIN users driver_users ON driver_users.id = drivers.user_id
     WHERE rides.booking_type = 'dropoff'
       AND rides.scheduled_pickup_at IS NOT NULL
       AND rides.ride_status IN ('requested', 'accepted')
       AND rides.reminder_now_sent = false`
  );

  for (const ride of dropoffRides.rows) {
    try {
      const hoursUntil = (new Date(ride.scheduled_pickup_at).getTime() - Date.now()) / (60 * 60 * 1000);
      await maybeSendAndMark(ride, hoursUntil);
    } catch (err) {
      console.error(`[scheduler] reminder check failed for dropoff ride #${ride.id}:`, err.message);
    }
  }

  const oneWayRides = await pool.query(
    `SELECT rides.*, users.push_token as rider_push_token, driver_users.push_token as driver_push_token
     FROM rides
     JOIN users ON users.id = rides.rider_id
     LEFT JOIN drivers ON drivers.id = rides.driver_id
     LEFT JOIN users driver_users ON driver_users.id = drivers.user_id
     WHERE rides.booking_type = 'one_way'
       AND rides.flight_number IS NOT NULL
       AND rides.ride_status IN ('requested', 'accepted')
       AND rides.reminder_now_sent = false`
  );

  for (const ride of oneWayRides.rows) {
    try {
      const flightInfo = await lookupFlightStatus(ride.flight_number);
      const anchor = flightInfo?.arrival?.estimated || flightInfo?.arrival?.scheduled;
      if (!anchor) continue; // can't compute a reminder window without a real ETA
      const hoursUntil = (new Date(anchor).getTime() - Date.now()) / (60 * 60 * 1000);
      await maybeSendAndMark(ride, hoursUntil);
    } catch (err) {
      console.error(`[scheduler] reminder check failed for one_way ride #${ride.id}:`, err.message);
    }
  }
}

async function maybeSendAndMark(ride, hoursUntil) {
  for (const threshold of REMINDER_THRESHOLDS) {
    if (ride[threshold.column]) continue; // already sent
    if (hoursUntil > threshold.hours) continue; // not there yet
    await sendReminder(ride, threshold.label, ride.driver_push_token);
    await pool.query(`UPDATE rides SET ${threshold.column} = true WHERE id = $1`, [ride.id]);
    ride[threshold.column] = true; // keep the in-memory row consistent in case a later threshold in this same pass also applies
  }
}

// Job 2 — flight cancellation/reschedule detection, scoped to 'dropoff'
// (return-leg) bookings with a tracked flight number — see the top-of-file
// comment and db/schema.sql for why this is deliberately narrower than
// "every flight-tracked ride."
const RESCHEDULE_DRIFT_MS = 60 * 60 * 1000; // 1 hour

async function sweepFlightIssues() {
  const candidates = await pool.query(
    `SELECT rides.*, users.push_token as rider_push_token, users.email as rider_email,
            users.whatsapp_number as rider_whatsapp_number
     FROM rides JOIN users ON users.id = rides.rider_id
     WHERE rides.booking_type = 'dropoff'
       AND rides.flight_number IS NOT NULL
       AND rides.flight_issue IS NULL
       AND rides.ride_status IN ('requested', 'accepted')`
  );

  for (const ride of candidates.rows) {
    try {
      const flightInfo = await lookupFlightStatus(ride.flight_number);
      if (!flightInfo) continue; // not configured / not found this pass — try again next sweep

      let issue = null;
      if (flightInfo.status === "cancelled") {
        issue = "cancelled";
      } else if (ride.original_flight_scheduled_at && flightInfo.departure?.scheduled) {
        const drift = Math.abs(
          new Date(flightInfo.departure.scheduled).getTime() - new Date(ride.original_flight_scheduled_at).getTime()
        );
        if (drift > RESCHEDULE_DRIFT_MS) issue = "rescheduled";
      }
      if (!issue) continue;

      await flagFlightIssue(ride, issue);
    } catch (err) {
      console.error(`[scheduler] flight-issue check failed for ride #${ride.id}:`, err.message);
    }
  }
}

async function flagFlightIssue(ride, issue) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Refund the original fare to the wallet as compensation for the
    // upfront charge no longer matching a booking whose timing just
    // changed — credited to the wallet regardless of which rail originally
    // collected it (card/wallet/membership), rather than trying to reverse
    // a live Paystack charge here. See routes/rides.js PATCH /:id/status
    // for where the fare gets re-collected, from the wallet, at drop-off.
    if (ride.payment_status === "paid") {
      const newBalanceResult = await client.query(
        "UPDATE users SET wallet_balance_naira = wallet_balance_naira + $1 WHERE id = $2 RETURNING wallet_balance_naira",
        [ride.fare_naira, ride.rider_id]
      );
      const newBalance = Number(newBalanceResult.rows[0].wallet_balance_naira);
      await client.query(
        `INSERT INTO wallet_transactions (user_id, type, status, amount_naira, balance_after_naira, ride_id, description)
         VALUES ($1, 'refund', 'completed', $2, $3, $4, $5)`,
        [ride.rider_id, ride.fare_naira, newBalance, ride.id, `Refund — flight ${ride.flight_number} ${issue}, Ride #${ride.id}`]
      );
    }

    await client.query(
      `UPDATE rides SET flight_issue = $1, flight_issue_notified_at = now(), payment_status = 'pending_reconfirmation', updated_at = now() WHERE id = $2`,
      [issue, ride.id]
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(`[scheduler] failed to flag flight issue for ride #${ride.id}:`, err.message);
    return;
  } finally {
    client.release();
  }

  if (ride.rider_push_token) {
    sendPushNotification(
      ride.rider_push_token,
      "Flight change detected",
      `Your flight ${ride.flight_number} was ${issue}. Your fare was refunded to your wallet — top up to at least $100 to keep your ride booked.`,
      { rideId: ride.id, type: "flight_issue" }
    ).catch(() => {});
  }
  if (ride.rider_whatsapp_number) {
    sendWhatsAppMessage(ride.rider_whatsapp_number, flightIssueMessage(ride, issue)).catch(() => {});
  }
  if (ride.rider_email) {
    sendFlightIssueEmail(ride.rider_email, ride, issue).catch(() => {});
  }
}

// Job 3 — preferred-driver claim-window expiry. A ride with
// preferred_driver_id set is only visible to that one driver (see GET
// /api/rides/available) until 3 hours before scheduled_pickup_at; past
// that, with no acceptance yet, it opens to every driver and the rider
// gets a heads-up about why their driver changed.
async function sweepPreferredDriverExpiry() {
  const expiring = await pool.query(
    `SELECT rides.*, users.push_token as rider_push_token, users.email as rider_email,
            users.whatsapp_number as rider_whatsapp_number
     FROM rides JOIN users ON users.id = rides.rider_id
     WHERE rides.preferred_driver_id IS NOT NULL
       AND rides.ride_status = 'requested'
       AND rides.scheduled_pickup_at IS NOT NULL
       AND rides.scheduled_pickup_at <= now() + interval '3 hours'`
  );

  for (const ride of expiring.rows) {
    try {
      const reason = "your regular driver wasn't available in time for this trip";
      await pool.query(
        "UPDATE rides SET preferred_driver_id = NULL, driver_change_reason = $1, updated_at = now() WHERE id = $2",
        [reason, ride.id]
      );
      if (ride.rider_push_token) {
        sendPushNotification(
          ride.rider_push_token,
          "A quick update on your driver",
          `We couldn't keep the same driver for this trip — ${reason}. We've opened it up to our other verified drivers.`,
          { rideId: ride.id, type: "driver_changed" }
        ).catch(() => {});
      }
      if (ride.rider_whatsapp_number) {
        sendWhatsAppMessage(ride.rider_whatsapp_number, driverChangedMessage(ride, reason)).catch(() => {});
      }
      if (ride.rider_email) {
        sendDriverChangedEmail(ride.rider_email, ride, reason).catch(() => {});
      }
    } catch (err) {
      console.error(`[scheduler] preferred-driver expiry failed for ride #${ride.id}:`, err.message);
    }
  }
}

async function runSweep() {
  await sweepReminders().catch((err) => console.error("[scheduler] sweepReminders crashed:", err.message));
  await sweepFlightIssues().catch((err) => console.error("[scheduler] sweepFlightIssues crashed:", err.message));
  await sweepPreferredDriverExpiry().catch((err) => console.error("[scheduler] sweepPreferredDriverExpiry crashed:", err.message));
}

function startScheduler() {
  console.log(`[scheduler] starting — sweeping every ${SWEEP_INTERVAL_MS / 60000} minutes`);
  runSweep(); // run once immediately on boot rather than waiting a full interval
  setInterval(runSweep, SWEEP_INTERVAL_MS);
}

module.exports = { startScheduler, runSweep };
