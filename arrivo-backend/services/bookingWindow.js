// Server-side copy of the booking window rules. Mirrors
// arrivo-app/utils/bookingWindow.js, which is what the apps use to grey the
// button out before anyone gets that far.
//
//   48h or more   standard booking, normal
//   12h to 48h    still open. The brief marks this "gap to resolve" and Ops
//                 hasn't ruled on it, so it's one constant to change.
//   under 12h     standard booking rejected, rider goes to On the Go
//
// Change ON_THE_GO_ONLY_HOURS here and in the app together if Ops closes the
// gap, otherwise the two disagree and the app lets someone submit something
// the API then refuses.

const STANDARD_MIN_HOURS = 48;
const ON_THE_GO_ONLY_HOURS = 12;

function hoursUntil(when, now = Date.now()) {
  // Check for nothing BEFORE building a Date. new Date(null) is epoch 0, which
  // is a perfectly finite number, so without this a booking with no scheduled
  // time reads as decades overdue and gets blocked. That's every airport
  // pickup, since those are timed off the flight and never carry a date here.
  if (when == null || when === "") return null;
  const time = when instanceof Date ? when.getTime() : new Date(when).getTime();
  if (!Number.isFinite(time)) return null;
  return (time - now) / (1000 * 60 * 60);
}

function bookingWindow(when, now = Date.now()) {
  const hours = hoursUntil(when, now);
  if (hours == null) return "standard";
  if (hours >= STANDARD_MIN_HOURS) return "standard";
  if (hours >= ON_THE_GO_ONLY_HOURS) return "gap";
  return "on_the_go_only";
}

function isStandardBookingBlocked(when, now = Date.now()) {
  return bookingWindow(when, now) === "on_the_go_only";
}

// Never just an error. The brief is explicit that a blocked rider always gets
// both routes offered, so the API hands back what the client needs to show them.
function blockedBookingResponse() {
  return {
    error: `Bookings this close to pickup go through On the Go instead. We need at least ${ON_THE_GO_ONLY_HOURS} hours for a standard booking.`,
    blockedByBookingWindow: true,
    onTheGoAvailable: true,
    whatsappNumber: "+2348162706078",
  };
}

module.exports = {
  STANDARD_MIN_HOURS,
  ON_THE_GO_ONLY_HOURS,
  hoursUntil,
  bookingWindow,
  isStandardBookingBlocked,
  blockedBookingResponse,
};
