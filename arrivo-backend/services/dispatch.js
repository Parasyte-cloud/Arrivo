// Getting a driver onto every booked ride.
//
// Before this, a booking told no driver anything. A ride only got a driver if
// someone happened to open the driver app and look, so rides sat "Unassigned".
// Now:
//   - Booking a ride pushes "New ride" to every online, approved driver who
//     can take it. A ride held for the rider's preferred driver goes to that
//     driver only, same as who can see it in GET /api/rides/available.
//   - When the preferred hold ends, or a ride is still unassigned 2 hours
//     before pickup, the online drivers hear about it again (once each).
//   - Ops can assign or change the driver from the console. The rider hears
//     exactly what they hear when a driver accepts (push, WhatsApp, email).
// Every step is written to ride_dispatch_events, which the Trip Tracker shows.
//
// Driver alerts carry the area and time only, never the rider's name or number.

const { pool } = require("../db/db");
const { sendPushNotification } = require("./pushNotifications");

const MAX_ALERTS = 100; // per ride per round, so a bad query can never page everyone twice over
const REMINDER_HOURS = 2;

// "Ikeja GRA, Lagos, Nigeria" -> "Ikeja GRA". Enough to decide, nothing more.
function area(address) {
  const first = String(address || "").split(",")[0].trim();
  return first.length > 40 ? `${first.slice(0, 39)}…` : first;
}

function lagosTime(at) {
  if (!at) return null;
  const d = new Date(new Date(at).getTime() + 60 * 60 * 1000); // WAT, no daylight saving
  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return `${DAYS[d.getUTCDay()]} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

function destinationOf(ride) {
  try {
    const stops = JSON.parse(ride.stops || "[]");
    return stops.length ? stops[stops.length - 1] : null;
  } catch {
    return null;
  }
}

// "Murtala Muhammed Airport → Victoria Island · Sat 14:30" and the like.
function rideAlertText(ride) {
  const to = destinationOf(ride);
  const when = lagosTime(ride.scheduled_pickup_at);
  const flight = ride.flight_number ? `flight ${ride.flight_number}` : null;
  const route = to ? `${area(ride.pickup_address)} → ${area(to)}` : area(ride.pickup_address);
  return [route, when, flight].filter(Boolean).join(" · ");
}

async function logEvent(db, e) {
  await db.query(
    `INSERT INTO ride_dispatch_events (ride_id, kind, actor_id, driver_id, from_driver_id, drivers_alerted, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [e.rideId, e.kind, e.actorId || null, e.driverId || null, e.fromDriverId || null, e.driversAlerted ?? null, e.note || null]
  );
}

// Online, approved drivers who could take this ride right now.
async function eligibleDrivers(ride, { onlyDriverId = null } = {}) {
  const r = await pool.query(
    `SELECT d.id, u.push_token
     FROM drivers d JOIN users u ON u.id = d.user_id
     WHERE d.is_verified AND d.is_online AND u.deleted_at IS NULL AND u.push_token IS NOT NULL
       AND ($1::int IS NULL OR d.id = $1)
     ORDER BY d.location_updated_at DESC NULLS LAST
     LIMIT ${MAX_ALERTS}`,
    [onlyDriverId]
  );
  return r.rows;
}

// Push "New ride" to the drivers who can take it. Never throws.
async function alertDrivers(rideId, kind = "alerted") {
  try {
    const ride = (await pool.query("SELECT * FROM rides WHERE id = $1", [rideId])).rows[0];
    if (!ride || ride.ride_status !== "requested" || ride.driver_id) return { alerted: 0 };
    const drivers = await eligibleDrivers(ride, { onlyDriverId: ride.preferred_driver_id || null });
    const text = rideAlertText(ride);
    const title = ride.preferred_driver_id ? "A rider asked for you" : "New ride available";
    await Promise.allSettled(drivers.map((d) =>
      sendPushNotification(d.push_token, title, `${text}. Open RideArrivo to accept.`, { rideId: ride.id, type: "new_ride" })));
    await logEvent(pool, { rideId: ride.id, kind, driversAlerted: drivers.length, note: ride.preferred_driver_id ? "preferred driver only" : null });
    return { alerted: drivers.length };
  } catch (e) {
    console.error(`[dispatch] alerting drivers for ride #${rideId} failed:`, e.message);
    return { alerted: 0, error: e.message };
  }
}

// Rides still without a driver 2 hours before pickup get one more round of
// alerts. Once per ride, tracked in ride_dispatch_events.
async function sweepUnassigned() {
  const due = await pool.query(
    `SELECT r.id FROM rides r
     WHERE r.ride_status = 'requested' AND r.driver_id IS NULL AND r.preferred_driver_id IS NULL
       AND r.scheduled_pickup_at IS NOT NULL
       AND r.scheduled_pickup_at BETWEEN now() AND now() + ($1 || ' hours')::interval
       AND NOT EXISTS (SELECT 1 FROM ride_dispatch_events e WHERE e.ride_id = r.id AND e.kind = 'reminder')
     ORDER BY r.scheduled_pickup_at
     LIMIT 50`,
    [String(REMINDER_HOURS)]
  );
  for (const { id } of due.rows) await alertDrivers(id, "reminder");
  return due.rows.length;
}

// What the rider hears when a driver takes their ride, whether the driver
// accepted it or ops assigned it.
async function tellRiderDriverAssigned(rideId, driverId) {
  const { sendDriverAssignedEmail } = require("./email");
  const { sendWhatsAppMessage, driverAssignedMessage } = require("./whatsapp");
  const ride = (await pool.query(
    `SELECT rides.*, users.name as rider_name, users.push_token as rider_push_token, users.email as rider_email,
            users.whatsapp_number as rider_whatsapp_number
     FROM rides JOIN users ON users.id = rides.rider_id WHERE rides.id = $1`, [rideId])).rows[0];
  if (!ride) return null;
  const d = (await pool.query(
    `SELECT u.name, v.make_model, v.plate_number FROM drivers d JOIN users u ON u.id = d.user_id
     LEFT JOIN vehicles v ON v.id = d.vehicle_id WHERE d.id = $1`, [driverId])).rows[0] || {};
  const driverName = d.name || "Your driver";
  const vehicleLabel = d.make_model ? `${d.make_model}${d.plate_number ? ` (${d.plate_number})` : ""}` : null;
  sendPushNotification(ride.rider_push_token, "Driver on the way", `${driverName} accepted your ride and is heading your way.`,
    { rideId: ride.id, type: "ride_accepted" }).catch(() => {});
  if (ride.rider_whatsapp_number) {
    sendWhatsAppMessage(ride.rider_whatsapp_number, driverAssignedMessage(ride, driverName, vehicleLabel)).catch(() => {});
  }
  if (ride.rider_email) sendDriverAssignedEmail(ride.rider_email, ride, driverName, vehicleLabel).catch(() => {});
  return ride;
}

class DispatchError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

// Put a driver on a ride from the console. Works on an unassigned ride, or
// swaps the driver on one that's accepted but not started. Same check a driver
// faces when accepting: approved. Being on a trip right now is fine, the ride
// may be hours away; the console shows it so ops can judge.
async function assignDriver({ rideId, driverId, actorId, note }) {
  const client = await pool.connect();
  let fromDriverId = null;
  try {
    await client.query("BEGIN");
    const ride = (await client.query("SELECT id, ride_status, driver_id FROM rides WHERE id = $1 FOR UPDATE", [rideId])).rows[0];
    if (!ride) throw new DispatchError(404, "not_found", "Ride not found.");
    if (!["requested", "accepted"].includes(ride.ride_status)) {
      throw new DispatchError(409, "wrong_status", `This ride is ${ride.ride_status.replace("_", " ")}, so its driver can't be changed here.`);
    }
    if (ride.driver_id === driverId) throw new DispatchError(409, "same_driver", "That driver already has this ride.");
    const d = (await client.query(
      `SELECT d.id, d.is_verified, u.deleted_at FROM drivers d JOIN users u ON u.id = d.user_id WHERE d.id = $1`, [driverId])).rows[0];
    if (!d || d.deleted_at) throw new DispatchError(404, "driver_not_found", "Driver not found.");
    if (!d.is_verified) throw new DispatchError(409, "not_verified", "That driver isn't approved yet.");

    fromDriverId = ride.driver_id;
    await client.query(
      `UPDATE rides SET driver_id = $2, ride_status = 'accepted', preferred_driver_id = NULL, updated_at = now() WHERE id = $1`,
      [rideId, driverId]);
    await logEvent(client, { rideId, kind: fromDriverId ? "reassigned" : "assigned", actorId, driverId, fromDriverId, note: note ? String(note).slice(0, 300) : null });
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  // Outside the transaction: a slow push must not hold the ride row.
  const tokens = (await pool.query(
    `SELECT d.id, u.push_token FROM drivers d JOIN users u ON u.id = d.user_id WHERE d.id = ANY($1)`,
    [[driverId, fromDriverId].filter(Boolean)])).rows;
  const tokenOf = (id) => (tokens.find((t) => t.id === id) || {}).push_token;
  const ride = (await pool.query("SELECT * FROM rides WHERE id = $1", [rideId])).rows[0];
  sendPushNotification(tokenOf(driverId), "Ride assigned to you", `${rideAlertText(ride)}. Open RideArrivo for the details.`,
    { rideId, type: "ride_assigned" }).catch(() => {});
  if (fromDriverId) {
    sendPushNotification(tokenOf(fromDriverId), "Ride moved to another driver", `Ride #${rideId} has been given to another driver by our team.`,
      { rideId, type: "ride_unassigned" }).catch(() => {});
  }
  await tellRiderDriverAssigned(rideId, driverId).catch((e) => console.error(`[dispatch] rider notice for #${rideId} failed:`, e.message));
  return { rideId, driverId, fromDriverId };
}

// Drivers ops can pick from, best first: online and free, then nearest to the pickup.
async function driverOptions(rideId) {
  const ride = (await pool.query("SELECT id, pickup_lat, pickup_lng, driver_id FROM rides WHERE id = $1", [rideId])).rows[0];
  if (!ride) return null;
  const r = await pool.query(
    `SELECT d.id, u.name, d.is_online, d.rating, d.current_lat, d.current_lng, d.location_updated_at,
            v.make_model, v.plate_number, v.vehicle_type,
            EXISTS (SELECT 1 FROM rides b WHERE b.driver_id = d.id AND b.ride_status = 'in_progress') AS mid_trip,
            (SELECT count(*)::int FROM rides a WHERE a.driver_id = d.id AND a.ride_status = 'accepted') AS upcoming
     FROM drivers d JOIN users u ON u.id = d.user_id LEFT JOIN vehicles v ON v.id = d.vehicle_id
     WHERE d.is_verified AND u.deleted_at IS NULL`);
  const toRad = (x) => (x * Math.PI) / 180;
  const km = (a, b, c, d) => {
    if ([a, b, c, d].some((v) => v == null)) return null;
    const dLat = toRad(c - a), dLng = toRad(d - b);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a)) * Math.cos(toRad(c)) * Math.sin(dLng / 2) ** 2;
    return Math.round(2 * 6371 * Math.asin(Math.sqrt(h)) * 10) / 10;
  };
  return r.rows.map((d) => ({
    id: d.id, name: d.name, online: d.is_online, rating: d.rating, midTrip: d.mid_trip, upcoming: d.upcoming,
    vehicle: d.make_model ? `${d.make_model}${d.plate_number ? ` (${d.plate_number})` : ""}` : null, vehicleType: d.vehicle_type,
    kmToPickup: km(Number(ride.pickup_lat), Number(ride.pickup_lng), d.current_lat, d.current_lng),
    lastSeen: d.location_updated_at, current: d.id === ride.driver_id,
  })).sort((a, b) =>
    (b.online - a.online) || (a.midTrip - b.midTrip) || ((a.kmToPickup ?? 1e9) - (b.kmToPickup ?? 1e9)) || a.name.localeCompare(b.name));
}

async function dispatchHistory(rideId) {
  const r = await pool.query(
    `SELECT e.id, e.kind, e.drivers_alerted, e.note, e.created_at, a.name AS actor_name, du.name AS driver_name, fu.name AS from_driver_name
     FROM ride_dispatch_events e
     LEFT JOIN users a ON a.id = e.actor_id
     LEFT JOIN drivers d ON d.id = e.driver_id LEFT JOIN users du ON du.id = d.user_id
     LEFT JOIN drivers f ON f.id = e.from_driver_id LEFT JOIN users fu ON fu.id = f.user_id
     WHERE e.ride_id = $1 ORDER BY e.id DESC LIMIT 30`, [rideId]);
  return r.rows;
}

module.exports = {
  alertDrivers, sweepUnassigned, assignDriver, driverOptions, dispatchHistory, tellRiderDriverAssigned,
  rideAlertText, area, DispatchError, REMINDER_HOURS,
};
