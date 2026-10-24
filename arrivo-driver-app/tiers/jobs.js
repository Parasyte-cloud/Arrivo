// What a driver sees for each of the six tiers, as plain data and small rules.
//
// Rides (RideArrivo airport trips, ArrivoChauffer bookings) and ArrivoExpress
// offers already reach the driver through the existing feed. ArrivoAir,
// ArrivoBoat and ArrivoRemovals reach the driver as jobs our team assigned
// after confirming a price with the rider. This file names all six the same
// way and holds the rules for running a service job.
//
// Kept import-free on purpose so tiers/jobs.test.js can load it with node.
// The backend test suite also reads the option lists here and fails if they
// drift from the server's (arrivo-backend services/serviceRequests.js).

export const TIER_LABELS = {
  ride: "RideArrivo",
  express: "ArrivoExpress",
  chauffer: "ArrivoChauffer",
  air: "ArrivoAir",
  boat: "ArrivoBoat",
  removals: "ArrivoRemovals",
};

export const SERVICE_TIERS = {
  air: {
    id: "air",
    label: "ArrivoAir",
    startLabel: "Start flight",
    finishLabel: "Complete flight",
    options: { helicopter: "Helicopter", private_jet: "Private jet" },
    whoLabel: "Passengers",
  },
  boat: {
    id: "boat",
    label: "ArrivoBoat",
    startLabel: "Start trip",
    finishLabel: "Complete trip",
    options: { speedboat: "Speedboat", ferry_transfer: "Ferry transfer", yacht: "Yacht" },
    whoLabel: "Passengers",
  },
  removals: {
    id: "removals",
    label: "ArrivoRemovals",
    startLabel: "Start move",
    finishLabel: "Complete move",
    options: { studio: "Studio", one_bed: "1 bedroom", two_bed: "2 bedroom", three_plus_bed: "3+ bedroom", office: "Office" },
    whoLabel: "Crew",
  },
};

// Which tier a ride row belongs to. one_way and dropoff are the airport trips
// RideArrivo is built around. Anything else booked as a ride is a chauffer
// booking. A ride flagged as on-demand is ArrivoExpress.
export function tierOfRide(ride) {
  if (!ride) return "ride";
  if (ride.service_mode === "instant") return "express";
  if (ride.booking_type === "one_way" || ride.booking_type === "dropoff") return "ride";
  return "chauffer";
}

// "RideArrivo pickup", "RideArrivo drop-off" or the tier name, for the badge on a card.
export function rideBadge(ride) {
  const tier = tierOfRide(ride);
  if (tier === "ride") return ride && ride.booking_type === "dropoff" ? "RideArrivo drop-off" : "RideArrivo pickup";
  return TIER_LABELS[tier];
}

// The one button a driver sees on a service job, or null when there is none.
// Only the assigned driver can run it, and only forward: start, then complete.
export function nextStep(job) {
  const tier = job && SERVICE_TIERS[job.tier];
  if (!tier) return null;
  if (job.status === "confirmed") return { to: "in_progress", label: tier.startLabel };
  if (job.status === "in_progress") return { to: "completed", label: tier.finishLabel };
  return null;
}

export function jobStatusLabel(status) {
  if (status === "confirmed") return "READY";
  if (status === "in_progress") return "UNDER WAY";
  if (status === "completed") return "DONE";
  if (status === "cancelled") return "CANCELLED";
  return String(status || "").replace("_", " ").toUpperCase();
}

export function optionName(tierId, value) {
  const tier = SERVICE_TIERS[tierId];
  return (tier && tier.options[value]) || value || "";
}

// "3 passengers", "4 movers", "1 passenger". Removals counts crew, the others people.
export function headcount(job) {
  if (!job) return "";
  if (job.tier === "removals") return job.crewSize ? `${job.crewSize} movers` : "";
  const n = Number(job.passengerCount);
  if (!Number.isFinite(n) || n < 1) return "";
  return n === 1 ? "1 passenger" : `${n} passengers`;
}

export function formatNaira(amount) {
  if (amount == null || amount === "") return "";
  const n = Number(amount);
  if (!Number.isFinite(n)) return "";
  return `₦${String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}

// When a job is due, written in Lagos time whatever the phone's zone (Lagos is
// UTC+1 all year).
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function dueLabel(at) {
  if (at == null) return "";
  const ms = at instanceof Date ? at.getTime() : new Date(at).getTime();
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms + 60 * 60 * 1000);
  const pad = (n) => (n < 10 ? `0${n}` : String(n));
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

// Whether a driver is tied up on a service job. New ride offers pause while
// this is true, so someone mid-move is not asked to take an airport pickup.
export function busyOnServiceJob(jobs) {
  return Array.isArray(jobs) && jobs.some((j) => j && j.status === "in_progress");
}

// Jobs in the order a driver should read them: the one under way first, then
// by when each is due, soonest first. Does not change the list it is given.
export function sortJobs(jobs) {
  if (!Array.isArray(jobs)) return [];
  const rank = (j) => (j.status === "in_progress" ? 0 : 1);
  const time = (j) => {
    const t = new Date(j.requestedAt).getTime();
    return Number.isFinite(t) ? t : Infinity;
  };
  return [...jobs].sort((a, b) => rank(a) - rank(b) || time(a) - time(b) || a.id - b.id);
}
