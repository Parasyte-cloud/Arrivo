const express = require("express");
const QRCode = require("qrcode");
const { pool } = require("../db/db");
const { requireAuth, requireRole, requireAnyRole } = require("../middleware/auth");

const router = express.Router();

// Both roles can view everything in this router — the distinction is that
// mutating routes below additionally require requireRole("admin") on top
// of this, so a 'support' token can GET any of these but gets a 403 on
// anything that changes data (verify a driver, resolve a panic, edit a ride).
router.use(requireAuth, requireAnyRole(["admin", "support"]));

// ── Drivers ──────────────────────────────────────────────────────────────

router.get("/drivers", async (req, res) => {
  const result = await pool.query(
    `SELECT drivers.id, drivers.is_verified, drivers.is_online, drivers.rating,
            drivers.license_number, drivers.lasdri_number, drivers.spoken_languages, drivers.created_at,
            drivers.current_lat, drivers.current_lng, drivers.location_updated_at,
            users.id as user_id, users.name, users.email, users.phone,
            vehicles.make_model, vehicles.plate_number, vehicles.vehicle_type
     FROM drivers
     JOIN users ON users.id = drivers.user_id
     LEFT JOIN vehicles ON vehicles.id = drivers.vehicle_id
     ORDER BY drivers.is_verified ASC, drivers.created_at DESC`
  );
  res.json({ drivers: result.rows });
});

router.patch("/drivers/:id/verify", requireRole("admin"), async (req, res) => {
  const existing = await pool.query("SELECT * FROM drivers WHERE id = $1", [req.params.id]);
  if (!existing.rows[0]) return res.status(404).json({ error: "Driver not found" });

  await pool.query("UPDATE drivers SET is_verified = $1 WHERE id = $2", [!!req.body.isVerified, req.params.id]);
  res.json({ id: Number(req.params.id), isVerified: !!req.body.isVerified });
});

// GET /api/admin/drivers/:id/qr — a printable QR code (PNG) for this driver's
// placard. Scanning it takes the rider to /scan.html, which confirms their
// currently-accepted ride and flips it to "in progress", starting tracking.
// scan_token never changes for a given driver, so a printed placard stays
// valid forever — re-printing is never needed just because of an app update.
router.get("/drivers/:id/qr", async (req, res) => {
  const driver = (await pool.query("SELECT scan_token FROM drivers WHERE id = $1", [req.params.id])).rows[0];
  if (!driver) return res.status(404).json({ error: "Driver not found" });
  if (!driver.scan_token) {
    return res.status(400).json({ error: "This driver has no scan token yet — ask them to save their profile once in the driver app or portal to generate one." });
  }

  const scanUrl = `${process.env.SCAN_BASE_URL || "https://ridearrivo.com/scan.html"}?token=${driver.scan_token}`;
  const pngBuffer = await QRCode.toBuffer(scanUrl, { width: 600, margin: 2 });

  res.set("Content-Type", "image/png");
  res.set("Content-Disposition", `inline; filename="driver-${req.params.id}-placard-qr.png"`);
  res.send(pngBuffer);
});

// ── Rides ────────────────────────────────────────────────────────────────

// GET /api/admin/rides — supports the same ?status= filter as before, plus:
//   ?search=   matches rider name/email/phone, driver name, or pickup address (case-insensitive)
//   ?from=     rides created on/after this ISO date
//   ?to=       rides created on/before this ISO date
// All are optional and combine with AND. Query stays fully parameterized —
// search is never string-concatenated into the SQL itself — to rule out
// injection via the admin search box.
router.get("/rides", async (req, res) => {
  const { status, search, from, to } = req.query;
  const baseQuery = `
    SELECT rides.*, riders.name as rider_name, riders.email as rider_email, riders.phone as rider_phone,
           driver_users.name as driver_name,
           drivers.current_lat, drivers.current_lng, drivers.location_updated_at
    FROM rides
    JOIN users riders ON riders.id = rides.rider_id
    LEFT JOIN drivers ON drivers.id = rides.driver_id
    LEFT JOIN users driver_users ON driver_users.id = drivers.user_id
  `;

  const conditions = [];
  const params = [];

  if (status) {
    params.push(status);
    conditions.push(`rides.ride_status = $${params.length}`);
  }
  if (search) {
    params.push(`%${search.toLowerCase()}%`);
    const idx = params.length;
    conditions.push(
      `(LOWER(riders.name) LIKE $${idx} OR LOWER(riders.email) LIKE $${idx} OR LOWER(COALESCE(riders.phone, '')) LIKE $${idx}
        OR LOWER(COALESCE(driver_users.name, '')) LIKE $${idx} OR LOWER(rides.pickup_address) LIKE $${idx})`
    );
  }
  if (from) {
    params.push(from);
    conditions.push(`rides.created_at >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    conditions.push(`rides.created_at <= $${params.length}::date + interval '1 day'`);
  }

  const whereClause = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
  const result = await pool.query(baseQuery + whereClause + ` ORDER BY rides.created_at DESC LIMIT 200`, params);

  res.json({ rides: result.rows.map((r) => ({ ...r, stops: JSON.parse(r.stops || "[]") })) });
});

router.patch("/rides/:id", requireRole("admin"), async (req, res) => {
  const { adminNotes, rideStatus } = req.body;
  const existing = await pool.query("SELECT * FROM rides WHERE id = $1", [req.params.id]);
  const ride = existing.rows[0];
  if (!ride) return res.status(404).json({ error: "Ride not found" });

  const allowedStatuses = ["requested", "accepted", "in_progress", "completed", "cancelled"];
  if (rideStatus && !allowedStatuses.includes(rideStatus)) {
    return res.status(400).json({ error: `rideStatus must be one of: ${allowedStatuses.join(", ")}` });
  }

  const updated = await pool.query(
    "UPDATE rides SET admin_notes = $1, ride_status = $2, updated_at = now() WHERE id = $3 RETURNING *",
    [adminNotes ?? ride.admin_notes, rideStatus || ride.ride_status, ride.id]
  );
  res.json({ ride: { ...updated.rows[0], stops: JSON.parse(updated.rows[0].stops || "[]") } });
});

// ── Live tracking ────────────────────────────────────────────────────────

// GET /api/admin/rides/live — every ride currently in progress, with the
// assigned driver's last known location. This is the "easy to track"
// dashboard view — no Google Maps API key required here, since we link out
// to a plain Google Maps URL (lat,lng) rather than embedding a live map.
router.get("/rides/live", async (req, res) => {
  const result = await pool.query(
    `SELECT rides.id, rides.pickup_address, rides.stops, rides.vehicle_type, rides.fare_naira,
            rides.ride_status, rides.tracking_started_at, rides.created_at,
            riders.name as rider_name, riders.phone as rider_phone,
            driver_users.name as driver_name, driver_users.phone as driver_phone,
            vehicles.make_model, vehicles.plate_number,
            drivers.current_lat, drivers.current_lng, drivers.location_updated_at,
            (rides.panic_triggered_at IS NOT NULL AND rides.panic_resolved_at IS NULL) as has_active_panic
     FROM rides
     JOIN users riders ON riders.id = rides.rider_id
     LEFT JOIN drivers ON drivers.id = rides.driver_id
     LEFT JOIN users driver_users ON driver_users.id = drivers.user_id
     LEFT JOIN vehicles ON vehicles.id = drivers.vehicle_id
     WHERE rides.ride_status = 'in_progress'
     ORDER BY rides.tracking_started_at ASC NULLS LAST`
  );
  res.json({
    rides: result.rows.map((r) => ({ ...r, stops: JSON.parse(r.stops || "[]") })),
  });
});

// ── Panic alerts ─────────────────────────────────────────────────────────

// GET /api/admin/panics — every ride with an active (unresolved) panic alert
router.get("/panics", async (req, res) => {
  const result = await pool.query(
    `SELECT rides.*, riders.name as rider_name, riders.phone as rider_phone, riders.email as rider_email,
            driver_users.name as driver_name, driver_users.phone as driver_phone,
            drivers.current_lat, drivers.current_lng
     FROM rides
     JOIN users riders ON riders.id = rides.rider_id
     LEFT JOIN drivers ON drivers.id = rides.driver_id
     LEFT JOIN users driver_users ON driver_users.id = drivers.user_id
     WHERE rides.panic_triggered_at IS NOT NULL AND rides.panic_resolved_at IS NULL
     ORDER BY rides.panic_triggered_at ASC`
  );
  res.json({ panics: result.rows.map((r) => ({ ...r, stops: JSON.parse(r.stops || "[]") })) });
});

// PATCH /api/admin/panics/:rideId/resolve — mark a panic alert as handled
router.patch("/panics/:rideId/resolve", requireRole("admin"), async (req, res) => {
  const { notes } = req.body;
  const existing = await pool.query("SELECT * FROM rides WHERE id = $1", [req.params.rideId]);
  if (!existing.rows[0]) return res.status(404).json({ error: "Ride not found" });

  const updated = await pool.query(
    "UPDATE rides SET panic_resolved_at = now(), panic_notes = $1, updated_at = now() WHERE id = $2 RETURNING *",
    [notes || existing.rows[0].panic_notes, req.params.rideId]
  );
  res.json({ ride: { ...updated.rows[0], stops: JSON.parse(updated.rows[0].stops || "[]") } });
});

// ── Waitlist ─────────────────────────────────────────────────────────────

// GET /api/admin/waitlist — every waitlist signup, for manual export into
// a marketing tool (Mailchimp, etc.) until a real CRM integration exists.
router.get("/waitlist", async (req, res) => {
  const result = await pool.query("SELECT email, source, created_at FROM waitlist ORDER BY created_at DESC");
  res.json({ waitlist: result.rows });
});

// ── Riders ───────────────────────────────────────────────────────────────

// GET /api/admin/riders — every rider account, with their ride count and
// last activity. This is what makes a "signed up but never booked" person
// visible — before this, that data existed only as a row in the database
// with no page to see it.
router.get("/riders", async (req, res) => {
  const result = await pool.query(
    `SELECT users.id, users.name, users.email, users.phone, users.preferred_language, users.created_at,
            users.id_document_url, users.id_verification_status, users.id_verification_submitted_at,
            users.id_verification_reviewed_at, users.id_verification_rejection_reason,
            users.wallet_balance_naira,
            COUNT(rides.id) as ride_count,
            COALESCE(SUM(CASE WHEN rides.payment_status = 'paid' THEN rides.fare_naira ELSE 0 END), 0) as total_spent_naira,
            MAX(rides.created_at) as last_ride_at
     FROM users
     LEFT JOIN rides ON rides.rider_id = users.id
     WHERE users.role = 'rider'
     GROUP BY users.id
     ORDER BY users.created_at DESC
     LIMIT 200`
  );
  res.json({
    riders: result.rows.map((r) => ({
      ...r,
      ride_count: Number(r.ride_count),
      total_spent_naira: Number(r.total_spent_naira),
      wallet_balance_naira: Number(r.wallet_balance_naira),
    })),
  });
});

// ── Wallet ledger ────────────────────────────────────────────────────────

// GET /api/admin/wallet-transactions — the full wallet_transactions log
// (top-ups, ride charges, membership charges, tips, refunds/credits), with
// the owning user's name/email joined in. This is the "real money is
// invisible" gap: before this, resolving a rider's balance dispute meant
// querying the database directly since nothing in the admin UI showed the
// underlying ledger a wallet_balance_naira figure is derived from.
// Optional ?userId= to drill into one rider's history (e.g. from the Riders
// page); otherwise returns the most recent transactions across everyone.
router.get("/wallet-transactions", async (req, res) => {
  const { userId } = req.query;
  const baseQuery = `
    SELECT wallet_transactions.*, users.name as user_name, users.email as user_email
    FROM wallet_transactions
    JOIN users ON users.id = wallet_transactions.user_id
  `;
  const result = userId
    ? await pool.query(baseQuery + ` WHERE wallet_transactions.user_id = $1 ORDER BY wallet_transactions.created_at DESC LIMIT 500`, [userId])
    : await pool.query(baseQuery + ` ORDER BY wallet_transactions.created_at DESC LIMIT 200`);

  res.json({
    transactions: result.rows.map((t) => ({ ...t, amount_naira: Number(t.amount_naira), balance_after_naira: t.balance_after_naira != null ? Number(t.balance_after_naira) : null })),
  });
});

// ── Memberships ──────────────────────────────────────────────────────────

// GET /api/admin/memberships — every membership row (individual annual,
// corporate account, and corporate delegate), with the member's name/email
// joined in, plus the company account's name/email when this row is a
// delegate (company_account_id set) so admin can see who's billing whom
// without cross-referencing user ids by hand.
router.get("/memberships", async (req, res) => {
  const result = await pool.query(
    `SELECT memberships.*, users.name as user_name, users.email as user_email,
            company_users.name as company_name, company_users.email as company_email
     FROM memberships
     JOIN users ON users.id = memberships.user_id
     LEFT JOIN users company_users ON company_users.id = memberships.company_account_id
     ORDER BY memberships.created_at DESC
     LIMIT 500`
  );
  res.json({
    memberships: result.rows.map((m) => ({ ...m, price_naira: Number(m.price_naira) })),
  });
});

// PATCH /api/admin/riders/:id/verify-id — approve or reject a rider's
// submitted ID photo (see POST /api/auth/submit-id-verification, which is
// what puts them in 'pending' in the first place). requireRole("admin")
// only — 'support' tokens can see the queue via GET /riders above but can't
// act on it, same split as verifying a driver.
// body: { status: 'verified' | 'rejected', rejectionReason? }
router.patch("/riders/:id/verify-id", requireRole("admin"), async (req, res) => {
  const { status, rejectionReason } = req.body;
  if (!["verified", "rejected"].includes(status)) {
    return res.status(400).json({ error: "status must be 'verified' or 'rejected'" });
  }
  const existing = await pool.query("SELECT id FROM users WHERE id = $1 AND role = 'rider'", [req.params.id]);
  if (!existing.rows[0]) return res.status(404).json({ error: "Rider not found" });

  const updated = await pool.query(
    `UPDATE users SET id_verification_status = $1, id_verification_reviewed_at = now(),
                       id_verification_rejection_reason = $2
     WHERE id = $3 RETURNING id, id_verification_status, id_verification_reviewed_at, id_verification_rejection_reason`,
    [status, status === "rejected" ? (rejectionReason || "Not specified") : null, req.params.id]
  );
  res.json({ rider: updated.rows[0] });
});

// ── Analytics ────────────────────────────────────────────────────────────

router.get("/analytics", async (req, res) => {
  const riderCount = Number((await pool.query("SELECT COUNT(*) as n FROM users WHERE role = 'rider'")).rows[0].n);
  const driverCount = Number((await pool.query("SELECT COUNT(*) as n FROM users WHERE role = 'driver'")).rows[0].n);
  const verifiedDriverCount = Number((await pool.query("SELECT COUNT(*) as n FROM drivers WHERE is_verified = true")).rows[0].n);
  const onlineDriverCount = Number((await pool.query("SELECT COUNT(*) as n FROM drivers WHERE is_online = true")).rows[0].n);
  const activePanicCount = Number(
    (await pool.query("SELECT COUNT(*) as n FROM rides WHERE panic_triggered_at IS NOT NULL AND panic_resolved_at IS NULL")).rows[0].n
  );

  const ridesByStatusResult = await pool.query("SELECT ride_status, COUNT(*) as n FROM rides GROUP BY ride_status");
  const ridesByStatus = ridesByStatusResult.rows.reduce((acc, row) => ({ ...acc, [row.ride_status]: Number(row.n) }), {});

  const revenue = Number(
    (await pool.query("SELECT COALESCE(SUM(fare_naira), 0) as total FROM rides WHERE payment_status = 'paid'")).rows[0].total
  );
  const revenueThisMonth = Number(
    (
      await pool.query(
        `SELECT COALESCE(SUM(fare_naira), 0) as total FROM rides
         WHERE payment_status = 'paid' AND date_trunc('month', created_at) = date_trunc('month', now())`
      )
    ).rows[0].total
  );

  res.json({
    riders: riderCount,
    drivers: driverCount,
    verifiedDrivers: verifiedDriverCount,
    onlineDrivers: onlineDriverCount,
    activePanics: activePanicCount,
    ridesByStatus,
    totalRevenueNaira: revenue,
    revenueThisMonthNaira: revenueThisMonth,
  });
});

module.exports = router;
