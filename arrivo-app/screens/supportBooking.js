// Which booking a support ticket gets attached to, and how we describe it.
// Kept out of SupportScreen.js so it can be tested with plain node. The
// screen itself pulls in react-native and can't be required outside Metro.
// See supportBooking.test.js.

// A trip that hasn't finished or been called off yet. Anything else is history.
export const ACTIVE_STATUSES = ["requested", "accepted", "in_progress"];

// If a trip is live that's almost certainly what they're writing in about, so
// grab that first and only fall back to the last one they booked. /api/rides/
// mine is already newest first, so find() gives us the newest live one.
export function pickBooking(rides) {
  if (!Array.isArray(rides)) return null;
  return rides.find((r) => ACTIVE_STATUSES.includes(r.ride_status)) || rides[0] || null;
}

// Short one-liner for the booking we're attaching. stops comes back already
// parsed into an array from the backend, and the last one is the destination.
export function describeRide(ride) {
  const stops = Array.isArray(ride.stops) ? ride.stops.filter(Boolean) : [];
  const destination = stops.length ? stops[stops.length - 1] : null;
  const when = ride.created_at ? new Date(ride.created_at).toLocaleDateString() : null;
  const route = destination ? `${ride.pickup_address} to ${destination}` : ride.pickup_address;
  return when ? `${route} · ${when}` : route;
}
