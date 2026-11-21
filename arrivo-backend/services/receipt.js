// Trip receipt for every service that runs a trip. Only a COMPLETED trip has
// one. The rider sees the driver and car, the driver sees the rider's name:
// each side gets the other's name only once the trip is done, never on an
// offer. The total is fare + overage + tip. The stored fare is already after
// any promo (see POST /api/rides), so the discount is shown, never subtracted
// a second time.
const { tierForRide } = require("./driverTiers");

const num = (v) => (v == null || v === "" ? 0 : Number(v) || 0);

class ReceiptError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}

function buildReceipt(row, viewer) {
  const express = !!row.instant_request_id;
  const service = express ? "express" : tierForRide(row);
  const fare = num(row.fare_naira), overage = num(row.overage_naira), tip = num(row.tip_naira);
  let stops = [];
  try { stops = JSON.parse(row.stops || "[]"); } catch { stops = []; }
  const lines = [{ label: "Fare", naira: fare }];
  if (overage > 0) lines.push({ label: row.overage_reason === "traffic_delay" ? "Traffic delay" : "Extra hours", naira: overage });
  if (tip > 0) lines.push({ label: "Tip", naira: tip });
  return {
    tripNumber: row.id,
    service,
    completedAt: row.completed_at,
    pickup: row.pickup_address,
    stops: Array.isArray(stops) ? stops.map((s) => (typeof s === "string" ? s : s?.address || s?.name || "")).filter(Boolean) : [],
    distanceKm: row.distance_km == null ? null : num(row.distance_km),
    durationMin: row.duration_min == null ? null : num(row.duration_min),
    lines,
    promo: num(row.promo_discount_naira) > 0 ? { code: row.promo_code || null, savedNaira: num(row.promo_discount_naira) } : null,
    totalNaira: lines.reduce((t, l) => t + l.naira, 0),
    paymentMethod: row.payment_method || null,
    paymentStatus: row.payment_status,
    // Each side sees the other's name, nothing else about them.
    rider: viewer === "driver" ? { name: row.rider_name } : null,
    driver: viewer === "rider" ? { name: row.driver_name, vehicle: row.make_model || null, plate: row.plate_number || null } : null,
  };
}

async function getReceipt(pool, rideId, userId) {
  const row = (await pool.query(
    `SELECT rides.*, riders.name AS rider_name, du.name AS driver_name, du.id AS driver_user_id,
            v.make_model, v.plate_number, irr.id AS instant_request_id
       FROM rides
       JOIN users riders ON riders.id = rides.rider_id
       LEFT JOIN drivers d ON d.id = rides.driver_id
       LEFT JOIN users du ON du.id = d.user_id
       LEFT JOIN vehicles v ON v.id = d.vehicle_id
       LEFT JOIN instant_ride_requests irr ON irr.ride_id = rides.id
      WHERE rides.id = $1`, [rideId])).rows[0];
  const viewer = row && (row.rider_id === userId ? "rider" : row.driver_user_id === userId ? "driver" : null);
  if (!row || !viewer) throw new ReceiptError(404, "Trip not found", "trip_not_found");
  if (row.ride_status !== "completed") throw new ReceiptError(409, "A receipt is ready once the trip is finished.", "trip_not_completed");
  return buildReceipt(row, viewer);
}

module.exports = { buildReceipt, getReceipt, ReceiptError };
