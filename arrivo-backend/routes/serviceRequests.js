// ArrivoAir, ArrivoBoat and ArrivoRemovals requests.
//
//   Rider    POST /            send a request
//            GET  /            my requests
//            GET  /:id         one of mine
//            POST /:id/cancel  withdraw it before the trip starts
//   Driver   GET   /driver/jobs   jobs ops assigned to me
//            PATCH /:id/status    start or finish a job that is mine
//   Staff    GET  /staff/queue    open requests, oldest first (read: admin, support, operations)
//            POST /:id/confirm    price + driver (admin only)
//            POST /:id/staff-cancel
//
// Phone numbers: the rider's number is stored so ops can ring to confirm, and
// is only ever sent to staff. Riders and drivers get none (contactPrivacy).
const express = require("express");
const { pool } = require("../db/db");
const { requireAuth, requireAnyRole } = require("../middleware/auth");
const { STAFF_ROLES } = require("../services/rideTeam");
const svc = require("../services/serviceRequests");

const router = express.Router();

const parseId = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 2147483647 ? n : null;
};

async function driverFor(userId) {
  const r = await pool.query("SELECT id, is_verified FROM drivers WHERE user_id = $1", [userId]);
  return r.rows[0] || null;
}

// ── Rider ────────────────────────────────────────────────────────────────

router.post("/", requireAuth, async (req, res) => {
  const parsed = svc.parseCreate(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const v = parsed.value;

  const inserted = await pool.query(
    `INSERT INTO service_requests
       (user_id, tier, pickup_address, destination_address, requested_at, passenger_count,
        option, crew_size, details, contact_phone, idempotency_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
     RETURNING *`,
    [req.user.id, v.tier, v.pickupAddress, v.destinationAddress, v.requestedAt, v.passengerCount,
     v.option, v.crewSize, v.details, v.contactPhone, v.idempotencyKey]
  );
  if (inserted.rows[0]) return res.status(201).json({ request: svc.toRiderView(inserted.rows[0]) });

  // Same key sent again: hand back the request that already exists.
  const prior = await pool.query(
    "SELECT * FROM service_requests WHERE user_id = $1 AND idempotency_key = $2",
    [req.user.id, v.idempotencyKey]
  );
  return res.status(200).json({ request: svc.toRiderView(prior.rows[0]), duplicate: true });
});

router.get("/", requireAuth, async (req, res) => {
  const r = await pool.query(
    "SELECT * FROM service_requests WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 50",
    [req.user.id]
  );
  res.json({ requests: r.rows.map(svc.toRiderView) });
});

// ── Driver ───────────────────────────────────────────────────────────────
// Registered before /:id so "driver" is not read as an id.

router.get("/driver/jobs", requireAuth, async (req, res) => {
  const driver = await driverFor(req.user.id);
  if (!driver) return res.status(403).json({ error: "Only drivers can view jobs" });
  const r = await pool.query(
    `SELECT sr.*, u.name AS rider_name
       FROM service_requests sr JOIN users u ON u.id = sr.user_id
      WHERE sr.driver_id = $1 AND sr.status IN ('confirmed', 'in_progress')
      ORDER BY sr.requested_at ASC, sr.id ASC`,
    [driver.id]
  );
  res.json({ jobs: r.rows.map(svc.toDriverView) });
});

router.patch("/:id/status", requireAuth, async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid id" });
  const to = String(req.body && req.body.status);
  const driver = await driverFor(req.user.id);
  if (!driver) return res.status(403).json({ error: "Only drivers can update a job" });

  const found = await pool.query("SELECT * FROM service_requests WHERE id = $1 AND driver_id = $2", [id, driver.id]);
  const row = found.rows[0];
  if (!row) return res.status(404).json({ error: "Job not found" });
  if (!svc.canTransition("driver", row.status, to)) {
    return res.status(409).json({ error: `A ${row.status.replace("_", " ")} job cannot be set to ${to}` });
  }

  // The WHERE on status makes two quick taps (or a tap racing ops) safe:
  // only one of them changes the row.
  const updated = await pool.query(
    `UPDATE service_requests
        SET status = $1, updated_at = now(), completed_at = CASE WHEN $1 = 'completed' THEN now() ELSE completed_at END
      WHERE id = $2 AND driver_id = $3 AND status = $4
      RETURNING *`,
    [to, id, driver.id, row.status]
  );
  if (!updated.rows[0]) return res.status(409).json({ error: "This job just changed. Refresh and try again." });
  const withName = { ...updated.rows[0], rider_name: (await pool.query("SELECT name FROM users WHERE id = $1", [row.user_id])).rows[0]?.name };
  res.json({ job: svc.toDriverView(withName) });
});

const staffRead = [requireAuth, requireAnyRole(STAFF_ROLES)];
// Only admin can change a request. Operations is read-only by policy
// (middleware/operationsReadOnly.js) and support is read-only by design.
const staffWrite = [requireAuth, requireAnyRole(["admin"])];

router.get("/staff/queue", ...staffRead, async (req, res) => {
  const r = await pool.query(
    `SELECT sr.*, u.name AS rider_name, u.phone AS rider_phone, du.name AS driver_name
       FROM service_requests sr
       JOIN users u ON u.id = sr.user_id
       LEFT JOIN drivers d ON d.id = sr.driver_id
       LEFT JOIN users du ON du.id = d.user_id
      WHERE sr.status IN ('pending', 'confirmed', 'in_progress')
      ORDER BY sr.created_at ASC, sr.id ASC
      LIMIT 200`
  );
  res.json({
    requests: r.rows.map((row) => ({
      ...svc.toRiderView(row),
      riderName: row.rider_name,
      riderPhone: row.rider_phone,
      contactPhone: row.contact_phone,
      driverId: row.driver_id,
      driverName: row.driver_name,
    })),
  });
});

// ── Rider: one request, cancel ───────────────────────────────────────────

router.get("/:id", requireAuth, async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid id" });
  const r = await pool.query("SELECT * FROM service_requests WHERE id = $1 AND user_id = $2", [id, req.user.id]);
  if (!r.rows[0]) return res.status(404).json({ error: "Request not found" });
  res.json({ request: svc.toRiderView(r.rows[0]) });
});

router.post("/:id/cancel", requireAuth, async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid id" });
  const r = await pool.query("SELECT * FROM service_requests WHERE id = $1 AND user_id = $2", [id, req.user.id]);
  const row = r.rows[0];
  if (!row) return res.status(404).json({ error: "Request not found" });
  if (!svc.canTransition("rider", row.status, "cancelled")) {
    return res.status(409).json({ error: "This request can no longer be cancelled here. Please contact support." });
  }
  const updated = await pool.query(
    `UPDATE service_requests SET status = 'cancelled', updated_at = now()
      WHERE id = $1 AND user_id = $2 AND status = $3 RETURNING *`,
    [id, req.user.id, row.status]
  );
  if (!updated.rows[0]) return res.status(409).json({ error: "This request just changed. Refresh and try again." });
  res.json({ request: svc.toRiderView(updated.rows[0]) });
});

// ── Staff ────────────────────────────────────────────────────────────────

router.post("/:id/confirm", ...staffWrite, async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid id" });
  const parsed = svc.parseConfirm(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  const driver = await pool.query("SELECT id, is_verified FROM drivers WHERE id = $1", [parsed.value.driverId]);
  if (!driver.rows[0]) return res.status(400).json({ error: "That driver does not exist" });
  if (!driver.rows[0].is_verified) return res.status(400).json({ error: "That driver is not verified yet" });

  const updated = await pool.query(
    `UPDATE service_requests
        SET status = 'confirmed', quoted_fare_naira = $1, driver_id = $2, confirmed_by = $3, updated_at = now()
      WHERE id = $4 AND status = 'pending'
      RETURNING *`,
    [parsed.value.fareNaira, parsed.value.driverId, req.user.id, id]
  );
  if (!updated.rows[0]) {
    const exists = await pool.query("SELECT status FROM service_requests WHERE id = $1", [id]);
    if (!exists.rows[0]) return res.status(404).json({ error: "Request not found" });
    return res.status(409).json({ error: `This request is already ${exists.rows[0].status.replace("_", " ")}` });
  }
  res.json({ request: svc.toRiderView(updated.rows[0]) });
});

router.post("/:id/staff-cancel", ...staffWrite, async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid id" });
  const r = await pool.query("SELECT status FROM service_requests WHERE id = $1", [id]);
  if (!r.rows[0]) return res.status(404).json({ error: "Request not found" });
  if (!svc.canTransition("staff", r.rows[0].status, "cancelled")) {
    return res.status(409).json({ error: `A ${r.rows[0].status.replace("_", " ")} request cannot be cancelled` });
  }
  const updated = await pool.query(
    "UPDATE service_requests SET status = 'cancelled', updated_at = now() WHERE id = $1 AND status = $2 RETURNING *",
    [id, r.rows[0].status]
  );
  if (!updated.rows[0]) return res.status(409).json({ error: "This request just changed. Refresh and try again." });
  res.json({ request: svc.toRiderView(updated.rows[0]) });
});

module.exports = router;
