const express = require("express");
const QRCode = require("qrcode");
const { pool } = require("../db/db");
const { requireAuth, requireRole, requireAnyRole } = require("../middleware/auth");
const { listConfig, setConfig } = require("../services/systemConfig");

const router = express.Router();

// Both roles can view everything in this router — the distinction is that
// mutating routes below additionally require requireRole("admin") on top
// of this, so a 'support' token can GET any of these but gets a 403 on
// anything that changes data (verify a driver, resolve a panic, edit a ride).
router.use(requireAuth, requireAnyRole(["admin", "support", "operations"]));

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
//
// The payload also carries the driver's name/vehicle/plate as query params
// alongside the token (not just the bare token). This is deliberate: a
// traveler scanning at the airport often has zero data connectivity, so the
// app decodes these straight off the QR code itself to show "your driver is
// X, driving a Y, plate Z" instantly, with no network round trip at all.
// The token is still what the backend actually trusts for the real
// confirm-and-start-tracking action (see POST /api/rides/scan) — these
// extra fields are display-only, never trusted for anything server-side.
// One consequence: if this driver's assigned vehicle changes later, this
// placard's plate/vehicle text goes stale until reprinted — same as any
// physical placard would need updating when a driver switches cars.
router.get("/drivers/:id/qr", async (req, res) => {
  const driver = (
    await pool.query(
      `SELECT drivers.scan_token, users.name as driver_name,
              vehicles.make_model, vehicles.plate_number, vehicles.vehicle_type
       FROM drivers
       JOIN users ON users.id = drivers.user_id
       LEFT JOIN vehicles ON vehicles.id = drivers.vehicle_id
       WHERE drivers.id = $1`,
      [req.params.id]
    )
  ).rows[0];
  if (!driver) return res.status(404).json({ error: "Driver not found" });
  if (!driver.scan_token) {
    return res.status(400).json({ error: "This driver has no scan token yet — ask them to save their profile once in the driver app or portal to generate one." });
  }

  // Built with encodeURIComponent field-by-field rather than
  // URLSearchParams#toString() — the latter encodes spaces as "+" (form
  // encoding), but the app's QR payload parser uses a plain regex +
  // decodeURIComponent (to avoid depending on URLSearchParams being
  // polyfilled in the RN runtime), which does NOT turn "+" back into a
  // space. %20 (what encodeURIComponent produces) decodes correctly with
  // both that regex parser AND the website's URLSearchParams, so this way
  // a driver name like "Ade Johnson" or vehicle "Toyota Camry" displays
  // correctly on both instead of showing literal "+" characters.
  const qs = [["token", driver.scan_token]];
  if (driver.driver_name) qs.push(["name", driver.driver_name]);
  if (driver.make_model) qs.push(["vehicle", driver.make_model]);
  if (driver.plate_number) qs.push(["plate", driver.plate_number]);
  if (driver.vehicle_type) qs.push(["type", driver.vehicle_type]);
  const queryString = qs.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");

  const scanUrl = `${process.env.SCAN_BASE_URL || "https://ridearrivo.com/scan.html"}?${queryString}`;
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

  // Marking a ride "completed" directly from here would bypass everything
  // routes/rides.js's PATCH /:id/status handler does at real completion
  // time (VALID_STATUS_TRANSITIONS, the flight-issue charge-at-drop-off
  // wallet debit, the fleet-escort driver payout) — this route only ever
  // touches admin_notes/ride_status with a plain UPDATE, so any of that
  // business logic would be silently skipped instead of run. Rather than
  // duplicate that logic here (and risk it drifting out of sync), refuse
  // and point the admin at the real completion flow whenever completing
  // this ride from here would skip money actually owed.
  if (rideStatus === "completed" && ride.ride_status !== "completed") {
    const needsFlightIssueCharge = !!ride.flight_issue && ride.payment_status !== "paid";
    const needsEscortPayout = ride.is_fleet_companion && ride.escort_payout_naira == null;
    if (needsFlightIssueCharge || needsEscortPayout) {
      return res.status(400).json({
        error:
          "This ride can't be marked completed directly from the admin panel because it still needs " +
          [
            needsFlightIssueCharge && "its flight-issue fare charged at drop-off",
            needsEscortPayout && "its fleet-escort driver payout recorded",
          ]
            .filter(Boolean)
            .join(" and ") +
          " — both only happen via the normal ride-completion flow (the driver's PATCH /api/rides/:id/status). Please complete this ride through that flow instead of setting its status here.",
      });
    }
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

// ── Flight issues ────────────────────────────────────────────────────────

// GET /api/admin/flight-issues — every ride the scheduler (services/scheduler.js)
// has flagged with a flight_issue ('cancelled' | 'rescheduled') that hasn't
// already finished or been cancelled outright. Mirrors the Panics queue's
// shape (a "needs attention" feed, not a raw table) since flight-issue rides
// are the other case where ops needs to proactively check on a rider rather
// than wait for them to complain — before this route, the only trace of a
// flight issue was columns on the ride row with no dedicated view.
router.get("/flight-issues", async (req, res) => {
  const result = await pool.query(
    `SELECT rides.id, rides.flight_number, rides.flight_issue, rides.flight_issue_notified_at,
            rides.original_flight_scheduled_at, rides.ride_status, rides.pickup_address,
            rides.scheduled_pickup_at, rides.created_at,
            riders.name as rider_name, riders.phone as rider_phone, riders.email as rider_email,
            driver_users.name as driver_name, driver_users.phone as driver_phone
     FROM rides
     JOIN users riders ON riders.id = rides.rider_id
     LEFT JOIN drivers ON drivers.id = rides.driver_id
     LEFT JOIN users driver_users ON driver_users.id = drivers.user_id
     WHERE rides.flight_issue IS NOT NULL AND rides.ride_status NOT IN ('completed', 'cancelled')
     ORDER BY rides.flight_issue_notified_at ASC NULLS LAST`
  );
  res.json({ flightIssues: result.rows });
});

// ── Vehicle owners ───────────────────────────────────────────────────────

// GET /api/admin/vehicles — every listed vehicle (routes/owners.js POST
// /vehicles), with its owner's name/email and whether it's currently
// assigned to a driver. Before this route, a vehicle only became visible
// in the admin panel once a verified driver was attached to it (via the
// Drivers page join) — anything an owner listed but that no driver has
// picked up yet had no page at all.
router.get("/vehicles", async (req, res) => {
  const result = await pool.query(
    `SELECT vehicles.*, owners.name as owner_name, owners.email as owner_email, owners.phone as owner_phone,
            driver_users.name as assigned_driver_name, drivers.is_verified as assigned_driver_verified
     FROM vehicles
     JOIN users owners ON owners.id = vehicles.owner_user_id
     LEFT JOIN drivers ON drivers.vehicle_id = vehicles.id
     LEFT JOIN users driver_users ON driver_users.id = drivers.user_id
     ORDER BY vehicles.created_at DESC`
  );
  res.json({ vehicles: result.rows });
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

// GET /api/admin/memberships — every membership row (Premium, Executive,
// and executive_profile — a profile user linked under someone else's
// Executive plan), with the member's name/email joined in, plus the
// linking Executive member's name/email when this row is a profile user
// (company_account_id set) so admin can see who's linked to whom without
// cross-referencing user ids by hand.
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

// ── Wallet adjustments (refunds / manual corrections) ───────────────────

// PATCH /api/admin/riders/:id/wallet-adjust — admin-only manual credit or
// debit to a rider's wallet, with a required description. This is the
// direct fix for what RidesPage's own admin-notes placeholder used to
// describe ("refunded ₦2,000 via Paystack manually") — before this route,
// every refund or balance correction happened entirely outside the app,
// leaving no record next to the wallet_transactions ledger it should live
// in. requireRole("admin") only, same split as verify-id/verify-driver —
// 'support' can see the Wallet ledger but can't move money.
// body: { amountNaira, description } — positive credits, negative debits.
router.patch("/riders/:id/wallet-adjust", requireRole("admin"), async (req, res) => {
  const { amountNaira, description } = req.body;
  const amount = Number(amountNaira);

  if (!Number.isFinite(amount) || amount === 0) {
    return res.status(400).json({ error: "amountNaira must be a non-zero number." });
  }
  if (Math.abs(amount) > 5000000) {
    return res.status(400).json({ error: "A single adjustment can't exceed ₦5,000,000. Split it into multiple steps if you need to move more." });
  }
  if (!description || !description.trim()) {
    return res.status(400).json({ error: "A description is required so this adjustment stays traceable later." });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const existing = await client.query(
      "SELECT wallet_balance_naira FROM users WHERE id = $1 AND role = 'rider' FOR UPDATE",
      [req.params.id]
    );
    if (!existing.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Rider not found" });
    }

    const currentBalance = Number(existing.rows[0].wallet_balance_naira);
    const newBalance = currentBalance + amount;
    if (newBalance < 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: `This would take the wallet negative (current balance ₦${currentBalance.toLocaleString()}).` });
    }

    await client.query("UPDATE users SET wallet_balance_naira = $1 WHERE id = $2", [newBalance, req.params.id]);

    const inserted = await client.query(
      `INSERT INTO wallet_transactions (user_id, type, status, amount_naira, balance_after_naira, description)
       VALUES ($1, 'admin_adjustment', 'completed', $2, $3, $4) RETURNING *`,
      [req.params.id, amount, newBalance, `${description.trim()} (admin: ${req.user.email})`]
    );

    await client.query("COMMIT");
    res.json({
      transaction: {
        ...inserted.rows[0],
        amount_naira: Number(inserted.rows[0].amount_naira),
        balance_after_naira: Number(inserted.rows[0].balance_after_naira),
      },
      newBalanceNaira: newBalance,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Wallet adjustment failed:", err.message);
    res.status(500).json({ error: "Could not adjust this rider's wallet. Please try again." });
  } finally {
    client.release();
  }
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


// ── Arrivo Express Phase 1: remotely-configurable parameters ──────────────
// Fair Fare's allowance/rate and Family Plan's placeholder pricing, all
// backed by services/systemConfig.js. GET is available to support/
// operations (read-only), PATCH is admin-only since it changes what
// riders are charged.
router.get("/config", async (req, res) => {
  const config = await listConfig();
  res.json({ config });
});

router.patch("/config/:key", requireRole("admin"), async (req, res) => {
  const { value } = req.body;
  if (value === undefined || value === null || value === "") {
    return res.status(400).json({ error: "value is required" });
  }
  try {
    await setConfig(req.params.key, value, req.user.id);
    const config = await listConfig();
    res.json({ config: config.find((c) => c.key === req.params.key) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Arrivo Ride Guarantee: cancellation log ────────────────────────────────
// Every driver cancel-request attempt (routes/rides.js POST
// /:id/cancel-request), valid or not, for support to review patterns
// (a driver citing "vehicle breakdown" every other trip, say).
router.get("/ride-cancellations", async (req, res) => {
  const result = await pool.query(
    `SELECT ride_cancellations.*, rides.pickup_address, rides.rider_id,
            driver_users.name AS driver_name, rider_users.name AS rider_name
       FROM ride_cancellations
       JOIN rides ON rides.id = ride_cancellations.ride_id
       LEFT JOIN drivers ON drivers.id = ride_cancellations.driver_id
       LEFT JOIN users driver_users ON driver_users.id = drivers.user_id
       LEFT JOIN users rider_users ON rider_users.id = rides.rider_id
      ORDER BY ride_cancellations.created_at DESC
      LIMIT 200`
  );
  res.json({ cancellations: result.rows });
});

// ── Arrivo Family Plan: admin visibility ───────────────────────────────────
router.get("/family-plans", async (req, res) => {
  const result = await pool.query(
    `SELECT fp.*, admin_user.name AS admin_name, admin_user.email AS admin_email,
            (SELECT COUNT(*) FROM family_members WHERE family_plan_id = fp.id AND status = 'active') AS member_count
       FROM family_plans fp
       JOIN users admin_user ON admin_user.id = fp.admin_user_id
      ORDER BY fp.created_at DESC
      LIMIT 200`
  );
  res.json({ familyPlans: result.rows });
});

// ── Arrivo Express Phase 2: 30-day launch promos ───────────────────────────
// Per-promo volume/discount totals (Early Bird, Morning Commuter) plus the
// Lucky Ride draw history -- "designed to prove demand and generate
// content" per the brief, so ops needs to see this without a DB query.
router.get("/launch-promos", async (req, res) => {
  const byPromo = await pool.query(
    `SELECT promo_code,
            COUNT(*) as ride_count,
            COALESCE(SUM(promo_discount_naira), 0) as total_discount_naira
       FROM rides
      WHERE promo_code IN ('early_bird', 'morning_commuter')
        AND ride_status != 'cancelled'
      GROUP BY promo_code`
  );

  const luckyRideDraws = await pool.query(
    `SELECT lucky_ride_draws.*, rides.fare_naira as winning_fare_naira,
            users.name as winner_name, users.email as winner_email
       FROM lucky_ride_draws
       LEFT JOIN rides ON rides.id = lucky_ride_draws.winning_ride_id
       LEFT JOIN users ON users.id = rides.rider_id
      ORDER BY lucky_ride_draws.draw_date DESC
      LIMIT 30`
  );

  res.json({ byPromo: byPromo.rows, luckyRideDraws: luckyRideDraws.rows });
});

// ── Arrivo Express Phase 3: Arrivo Share reporting ─────────────────────────
// Just visibility, not management -- Arrivo Share has no admin-editable
// settings of its own (its passenger cap already lives in
// services/fare.js's MAX_PASSENGERS, shared with every other booking).
router.get("/arrivo-share", async (req, res) => {
  const summary = await pool.query(
    `SELECT COUNT(*) as shared_ride_count,
            COALESCE(SUM(participant_counts.count), 0) as total_co_riders
       FROM rides
       LEFT JOIN (
         SELECT ride_id, COUNT(*) as count FROM ride_share_participants GROUP BY ride_id
       ) participant_counts ON participant_counts.ride_id = rides.id
      WHERE rides.is_arrivo_share = true AND rides.ride_status != 'cancelled'`
  );
  const recentShared = await pool.query(
    `SELECT rides.id, rides.pickup_address, rides.vehicle_type, rides.ride_status, rides.created_at,
            organizer.name as organizer_name,
            COALESCE(json_agg(json_build_object('name', co_riders.name, 'phone', co_riders.phone))
                     FILTER (WHERE co_riders.id IS NOT NULL), '[]') as co_riders
       FROM rides
       JOIN users organizer ON organizer.id = rides.rider_id
       LEFT JOIN ride_share_participants ON ride_share_participants.ride_id = rides.id
       LEFT JOIN users co_riders ON co_riders.id = ride_share_participants.user_id
      WHERE rides.is_arrivo_share = true
      GROUP BY rides.id, organizer.name
      ORDER BY rides.created_at DESC
      LIMIT 30`
  );
  res.json({ summary: summary.rows[0], recentShared: recentShared.rows });
});

// ── Partner Venues program: admin CRUD ──────────────────────────────────
// Full CRUD, admin-only for anything that mutates (matches the config
// endpoints above) -- support/operations can still see the list via the
// router-wide requireAnyRole, since they're the ones fielding a rider's
// "why didn't my reserved pickup show a perk" question.
router.get("/partner-venues", async (req, res) => {
  const result = await pool.query("SELECT * FROM partner_venues ORDER BY name ASC");
  res.json({ venues: result.rows });
});

// Same "never trust unvalidated coordinates" principle as the fare/dispatch
// code -- a bad lat/lng here would silently break the partner-venue area-lock
// radius check and the pickup-address override in POST /api/rides for
// every rider booking from this venue. Returns an error string, or null
// if the value is fine (undefined/null is fine -- coordinates are optional).
function invalidCoordinate(value, label) {
  if (value === undefined || value === null || value === "") return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return `${label} must be a number.`;
  if (label === "lat" && (num < -90 || num > 90)) return "lat must be between -90 and 90.";
  if (label === "lng" && (num < -180 || num > 180)) return "lng must be between -180 and 180.";
  return null;
}

router.post("/partner-venues", requireRole("admin"), async (req, res) => {
  const { name, category, address, lat, lng, perkDescription } = req.body;
  if (!name || !address) return res.status(400).json({ error: "name and address are required" });
  const allowedCategories = ["club", "restaurant", "other"];
  if (category && !allowedCategories.includes(category)) {
    return res.status(400).json({ error: `category must be one of: ${allowedCategories.join(", ")}` });
  }
  const latError = invalidCoordinate(lat, "lat");
  if (latError) return res.status(400).json({ error: latError });
  const lngError = invalidCoordinate(lng, "lng");
  if (lngError) return res.status(400).json({ error: lngError });
  const inserted = await pool.query(
    `INSERT INTO partner_venues (name, category, address, lat, lng, perk_description)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [name, category || "other", address, lat === undefined || lat === "" ? null : lat, lng === undefined || lng === "" ? null : lng, perkDescription || null]
  );
  res.status(201).json({ venue: inserted.rows[0] });
});

router.patch("/partner-venues/:id", requireRole("admin"), async (req, res) => {
  const { name, category, address, lat, lng, perkDescription, isActive } = req.body;
  const allowedCategories = ["club", "restaurant", "other"];
  if (category && !allowedCategories.includes(category)) {
    return res.status(400).json({ error: `category must be one of: ${allowedCategories.join(", ")}` });
  }
  const latError = invalidCoordinate(lat, "lat");
  if (latError) return res.status(400).json({ error: latError });
  const lngError = invalidCoordinate(lng, "lng");
  if (lngError) return res.status(400).json({ error: lngError });
  const existing = await pool.query("SELECT * FROM partner_venues WHERE id = $1", [req.params.id]);
  if (!existing.rows[0]) return res.status(404).json({ error: "Partner venue not found." });
  const current = existing.rows[0];

  const updated = await pool.query(
    `UPDATE partner_venues SET
       name = $1, category = $2, address = $3, lat = $4, lng = $5, perk_description = $6, is_active = $7, updated_at = now()
     WHERE id = $8 RETURNING *`,
    [
      name ?? current.name,
      category ?? current.category,
      address ?? current.address,
      lat !== undefined ? lat : current.lat,
      lng !== undefined ? lng : current.lng,
      perkDescription !== undefined ? perkDescription : current.perk_description,
      isActive !== undefined ? isActive : current.is_active,
      req.params.id,
    ]
  );
  res.json({ venue: updated.rows[0] });
});

module.exports = router;
