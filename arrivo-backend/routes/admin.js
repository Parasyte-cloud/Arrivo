const express = require("express");
const { logSafetyEvent } = require("../services/safetyEvents");
const QRCode = require("qrcode");
const { pool } = require("../db/db");
const { requireAuth, requireRole, requireAnyRole } = require("../middleware/auth");
const { listConfig, setConfig } = require("../services/systemConfig");
const { lookupFlight } = require("../services/flightLookup");
const pnrVault = require("../services/pnrVault");
const flightCredit = require("../services/flightCredit");
const { phoneHint } = require("../services/rideTeam");
const { sendPushNotification } = require("../services/pushNotifications");
const { sendWhatsAppMessage, driverAssignedMessage } = require("../services/whatsapp");
const { sendDriverAssignedEmail } = require("../services/email");

const router = express.Router();

// Both roles can view everything in this router — the distinction is that
// mutating routes below additionally require requireRole("admin") on top
// of this, so a 'support' token can GET any of these but gets a 403 on
// anything that changes data (verify a driver, resolve a panic, edit a ride).
router.use(requireAuth, requireAnyRole(["admin", "support", "operations"]));

// ── Drivers ──────────────────────────────────────────────────────────────

// Drivers who signed up through the new engine have ids like "engine:abc". They are managed in
// Driver Verification, not here, so any change aimed at one is refused with a clear message.
router.use("/drivers/:id", (req, res, next) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: "This driver is managed in Driver Verification, not on this page." });
  next();
});

router.get("/drivers", async (req, res) => {
  const result = await pool.query(
    `SELECT drivers.id, drivers.is_verified, drivers.is_online, drivers.rating,
            drivers.license_number, drivers.lasdri_number, drivers.spoken_languages, drivers.created_at,
            drivers.current_lat, drivers.current_lng, drivers.location_updated_at,
            drivers.tier, drivers.archived_at,
            COALESCE((SELECT array_agg(a.tier ORDER BY a.tier) FROM driver_tier_access a WHERE a.driver_id = drivers.id AND a.status = 'active'), '{}') AS tiers,
            users.id as user_id, users.name, users.email, users.phone,
            vehicles.make_model, vehicles.plate_number, vehicles.vehicle_type
     FROM drivers
     JOIN users ON users.id = drivers.user_id
     LEFT JOIN vehicles ON vehicles.id = drivers.vehicle_id
     WHERE ${req.query.archived === "1" ? "drivers.archived_at IS NOT NULL" : "drivers.archived_at IS NULL"}
     ORDER BY drivers.is_verified ASC, drivers.created_at DESC`
  );
  const engine = req.query.archived === "1" ? { status: "skipped", drivers: [] } : await require("../services/engineDrivers").fetchEngineDrivers();
  const merged = [...result.rows.map((r) => ({ ...r, source: "legacy" })), ...engine.drivers].sort(
    (a, b) => Number(a.is_verified) - Number(b.is_verified) || new Date(b.created_at || 0) - new Date(a.created_at || 0)
  );
  res.json({ drivers: merged, engineStatus: engine.status });
});

const DRIVER_TIERS = ["ride", "express", "chauffeur", "air", "boat", "removals", "campus"];

// Archive hides a driver and takes them off the road. It is reversible. Restoring leaves
// them unverified so someone has to verify them again on purpose.
router.patch("/drivers/:id/archive", requireRole("admin"), async (req, res) => {
  const archived = req.body && req.body.archived !== false;
  const r = archived
    ? await pool.query("UPDATE drivers SET archived_at = now(), is_online = false, is_verified = false WHERE id = $1 RETURNING id", [req.params.id])
    : await pool.query("UPDATE drivers SET archived_at = NULL WHERE id = $1 RETURNING id", [req.params.id]);
  if (!r.rows[0]) return res.status(404).json({ error: "Driver not found" });
  res.json({ id: r.rows[0].id, archived });
});

// Delete is for test accounts only: it refuses while the driver has any trip history.
router.delete("/drivers/:id", requireRole("admin"), async (req, res) => {
  const d = await pool.query("SELECT id, archived_at FROM drivers WHERE id = $1", [req.params.id]);
  if (!d.rows[0]) return res.status(404).json({ error: "Driver not found" });
  if (!d.rows[0].archived_at) return res.status(409).json({ error: "Archive the driver first, then delete." });
  const trips = await pool.query("SELECT 1 FROM rides WHERE driver_id = $1 LIMIT 1", [req.params.id]);
  if (trips.rows[0]) return res.status(409).json({ error: "This driver has trip history, so it stays archived instead of deleted." });
  // The delete gets its own short time limit so a locked row answers with an error instead of hanging the page.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = 8000");
    await client.query("DELETE FROM drivers WHERE id = $1", [req.params.id]);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    if (e.code === "23503") return res.status(409).json({ error: "This driver is still linked to other records, so it stays archived instead of deleted." });
    if (e.code === "57014") return res.status(503).json({ error: "The database was busy, so nothing was deleted. Try again in a moment." });
    throw e;
  } finally {
    client.release();
  }
  res.json({ id: Number(req.params.id), deleted: true });
});

router.patch("/drivers/:id/tier", requireRole("admin"), async (req, res) => {
  const tier = req.body && req.body.tier;
  if (tier !== null && !DRIVER_TIERS.includes(tier)) return res.status(400).json({ error: `tier must be one of: ${DRIVER_TIERS.join(", ")}` });
  const r = await pool.query("UPDATE drivers SET tier = $1 WHERE id = $2 RETURNING id", [tier, req.params.id]);
  if (!r.rows[0]) return res.status(404).json({ error: "Driver not found" });
  res.json({ id: r.rows[0].id, tier });
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
        OR LOWER(COALESCE(driver_users.name, '')) LIKE $${idx} OR LOWER(rides.pickup_address) LIKE $${idx}
        OR LOWER(COALESCE(rides.flight_number, '')) LIKE $${idx} OR rides.id::text = $${idx + 1})`
    );
    params.push(String(search).trim().replace(/^#/, ""));
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

// PATCH /rides/:id/driver — manual driver assignment, for when a ride needs a
// driver put on it (or taken off it) by hand instead of waiting for a driver
// to self-accept from the available-rides list (see routes/rides.js GET
// /available and PATCH /:id/accept). This is deliberately a thin, separate
// route rather than folded into the generic PATCH /rides/:id above: it only
// ever touches driver_id/ride_status, never money, so it carries none of
// that route's completion guardrails and doesn't need to.
// POST /api/admin/service-jobs: Ops creates a job for a quote-first service
// (Campus, Air, Boat, Removals). It is a normal ride row tagged with its
// service, so a driver who holds the service sees it in their queue, and the
// "Are you safe?" check and the receipt work on it like any other trip.
// Payment is agreed with the customer outside the app (invoice or transfer);
// `paid: true` records that it has been settled.
router.post("/service-jobs", requireRole("admin"), async (req, res) => {
  const { SERVICE_JOB_TIERS } = require("../services/driverTiers");
  const b = req.body || {};
  const service = String(b.service || "").toLowerCase();
  if (!SERVICE_JOB_TIERS.includes(service)) return res.status(400).json({ error: `service must be one of: ${SERVICE_JOB_TIERS.join(", ")}.` });
  const pickup = String(b.pickup || "").trim();
  const destination = String(b.destination || "").trim();
  if (pickup.length < 3) return res.status(400).json({ error: "Add a pickup address." });
  if (destination.length < 3) return res.status(400).json({ error: "Add a destination." });
  const quote = Number(b.quoteNaira);
  if (!Number.isInteger(quote) || quote < 0 || quote > 50000000) return res.status(400).json({ error: "quoteNaira must be a whole number of naira, 0 or more." });
  const email = String(b.riderEmail || "").trim().toLowerCase();
  const rider = (await pool.query("SELECT id, role FROM users WHERE lower(email) = $1", [email])).rows[0];
  if (!rider || rider.role !== "rider") return res.status(404).json({ error: "No rider account with that email. They need to sign up in the rider app first." });
  const paid = b.paid === true;
  const created = await pool.query(
    `INSERT INTO rides (rider_id, pickup_address, stops, booking_type, service, fare_naira, payment_status, payment_method,
                        ride_status, agreed_cancellation_policy, admin_notes)
     VALUES ($1, $2, $3, 'service_job', $4, $5, $6, $7, 'requested', true, $8) RETURNING *`,
    [rider.id, pickup, JSON.stringify([destination]), service, quote, paid ? "paid" : "pending", paid ? "invoice" : null,
     b.notes ? String(b.notes).slice(0, 1000) : null]
  );
  const ride = created.rows[0];
  await logSafetyEvent(pool, "service_job_created", { rideId: ride.id, userId: req.user.id, detail: { service, quoteNaira: quote, paid } });
  res.status(201).json({ ride: { ...ride, stops: JSON.parse(ride.stops || "[]") } });
});

// PATCH /api/admin/service-jobs/:id/quote: Ops sets the agreed price on a rider-ordered
// service job, which lets the driver start it. `paid: true` records that it is settled.
router.patch("/service-jobs/:id/quote", requireRole("admin"), async (req, res) => {
  const quote = Number(req.body && req.body.quoteNaira);
  if (!Number.isInteger(quote) || quote < 1 || quote > 50000000) return res.status(400).json({ error: "quoteNaira must be a whole number of naira, 1 or more." });
  const paid = req.body.paid === true;
  const r = await pool.query(
    `UPDATE rides SET fare_naira = $2, quote_pending = false, payment_status = $3,
            payment_method = CASE WHEN $3 = 'paid' THEN 'invoice' ELSE payment_method END, updated_at = now()
     WHERE id = $1 AND service IS NOT NULL AND ride_status IN ('requested','accepted') RETURNING *`,
    [req.params.id, quote, paid ? "paid" : "pending"]);
  if (!r.rows[0]) return res.status(404).json({ error: "No open service job with that id." });
  await logSafetyEvent(pool, "service_job_quoted", { rideId: r.rows[0].id, userId: req.user.id, detail: { quoteNaira: quote, paid } });
  res.json({ ride: { ...r.rows[0], stops: JSON.parse(r.rows[0].stops || "[]") } });
});

router.patch("/rides/:id/driver", requireRole("admin"), async (req, res) => {
  const { driverId } = req.body;
  const existing = await pool.query("SELECT * FROM rides WHERE id = $1", [req.params.id]);
  const ride = existing.rows[0];
  if (!ride) return res.status(404).json({ error: "Ride not found" });

  if (["completed", "cancelled"].includes(ride.ride_status)) {
    return res.status(400).json({ error: `This ride is already ${ride.ride_status} — its driver can't be changed from here.` });
  }

  // driverId: null un-assigns and sends the ride back to "requested" (waiting
  // for a driver), same as a driver cancelling an accepted ride.
  if (driverId === null || driverId === undefined) {
    const updated = await pool.query(
      `UPDATE rides SET driver_id = NULL,
              ride_status = CASE WHEN ride_status IN ('accepted', 'in_progress') THEN 'requested' ELSE ride_status END,
              updated_at = now()
       WHERE id = $1 RETURNING *`,
      [ride.id]
    );
    return res.json({ ride: { ...updated.rows[0], stops: JSON.parse(updated.rows[0].stops || "[]") } });
  }

  const driver = await pool.query(
    `SELECT drivers.id, drivers.is_verified, drivers.vehicle_id, users.name, users.push_token as driver_push_token
     FROM drivers JOIN users ON users.id = drivers.user_id
     WHERE drivers.id = $1`,
    [driverId]
  );
  if (!driver.rows[0]) return res.status(404).json({ error: "Driver not found" });
  if (!driver.rows[0].is_verified) {
    return res.status(400).json({ error: `${driver.rows[0].name} isn't verified yet — verify them on the Drivers page first.` });
  }

  // Putting a driver on a "requested" ride is the same as them accepting
  // it: move it to "accepted". A ride already "accepted" or "in_progress"
  // just gets handed to the new driver instead — its status doesn't change
  // (this is meant for correcting a wrong assignment, not re-dispatching
  // mid-trip; the admin should confirm with both drivers before doing that).
  //
  // The "requested" case gets the exact same atomic guard as a driver's own
  // POST /api/rides/:id/accept (routes/rides.js): WHERE ride_status =
  // 'requested' AND driver_id IS NULL. Without it, an admin assigning a
  // driver at the same moment a different driver self-accepts could silently
  // overwrite that driver's acceptance — the admin's write would land second
  // and just stomp on it with no error either way. The "already accepted/
  // in_progress" reassignment path below doesn't need this: by definition no
  // driver's self-accept can race it, since self-accept itself requires
  // ride_status = 'requested'.
  const wasRequested = ride.ride_status === "requested";
  const updated = await pool.query(
    wasRequested
      ? `UPDATE rides SET driver_id = $1, ride_status = 'accepted', updated_at = now()
         WHERE id = $2 AND ride_status = 'requested' AND driver_id IS NULL RETURNING *`
      : `UPDATE rides SET driver_id = $1, updated_at = now()
         WHERE id = $2 RETURNING *`,
    [driverId, ride.id]
  );

  if (wasRequested && updated.rowCount === 0) {
    return res.status(409).json({ error: "This ride was just accepted by another driver. Refresh and try again." });
  }

  const finalRide = updated.rows[0];

  // Staff may put ANY verified driver on ANY ride, on purpose: ops sometimes has
  // to cover a gap. It is never blocked, but when the driver does not hold the
  // service this ride belongs to, that is written to the audit trail and the
  // response says so, so the console can show a note and nobody is surprised.
  const rideTier = require("../services/driverTiers").tierForRide(finalRide);
  const isExpress = (await pool.query("SELECT 1 FROM instant_ride_requests WHERE ride_id = $1", [finalRide.id])).rowCount > 0;
  const tier = isExpress ? "express" : rideTier;
  const holds = (await pool.query("SELECT 1 FROM driver_tier_access WHERE driver_id = $1 AND tier = $2 AND status = 'active'", [driverId, tier])).rowCount > 0;
  const tierNote = holds ? null : `${driver.rows[0].name} does not hold the ${tier} service. Assigned by staff anyway.`;
  if (!holds) {
    await logSafetyEvent(pool, "manual_assignment_without_tier", { rideId: finalRide.id, userId: req.user.id, driverId: Number(driverId), detail: { tier } });
  }

  // Manual assignment skips the normal accept flow entirely, so neither
  // side hears about it from the app on its own — unlike a driver
  // self-accepting (routes/rides.js POST /:id/accept), which already
  // notifies the rider. Same three rider channels as that route, plus a
  // push to the driver, who otherwise has no way to know ops put this on
  // their queue.
  const riderContact = await pool.query(
    "SELECT push_token as rider_push_token, whatsapp_number as rider_whatsapp_number, email as rider_email FROM users WHERE id = $1",
    [finalRide.rider_id]
  );
  const vehicleInfo = driver.rows[0].vehicle_id
    ? await pool.query("SELECT make_model, plate_number FROM vehicles WHERE id = $1", [driver.rows[0].vehicle_id])
    : { rows: [] };
  const vehicleLabel = vehicleInfo.rows[0]?.make_model
    ? `${vehicleInfo.rows[0].make_model}${vehicleInfo.rows[0].plate_number ? " (" + vehicleInfo.rows[0].plate_number + ")" : ""}`
    : null;
  const driverName = driver.rows[0].name;
  const rider = riderContact.rows[0] || {};

  if (rider.rider_push_token) {
    sendPushNotification(
      rider.rider_push_token,
      "Driver assigned",
      `${driverName} has been assigned to your ride.`,
      { rideId: finalRide.id, type: "ride_accepted" }
    ).catch(() => {});
  }
  if (rider.rider_whatsapp_number) {
    sendWhatsAppMessage(rider.rider_whatsapp_number, driverAssignedMessage(finalRide, driverName, vehicleLabel)).catch(() => {});
  }
  if (rider.rider_email) {
    sendDriverAssignedEmail(rider.rider_email, finalRide, driverName, vehicleLabel).catch(() => {});
  }
  if (driver.rows[0].driver_push_token) {
    sendPushNotification(
      driver.rows[0].driver_push_token,
      "New ride assigned",
      `Ops assigned you ride #${finalRide.id} — ${finalRide.pickup_address}. Check the app for details.`,
      { rideId: finalRide.id, type: "ride_assigned_manual" }
    ).catch(() => {});
  }

  res.json({ ride: { ...finalRide, stops: JSON.parse(finalRide.stops || "[]") }, tierNote });
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

// ── Trip tracker ─────────────────────────────────────────────────────────
//
// The Ops Console "Trip Tracker" page: every ride that is waiting for a driver,
// has a driver on the way, or is on the road, plus anything that finished in the
// last two hours so the team can see the end of a trip. The driver's position comes
// from drivers.current_lat/current_lng, the same source as the Live Map above.

const TRIP_SELECT = `
  SELECT rides.id, rides.ride_status, rides.payment_status, rides.pickup_address, rides.stops,
         rides.pickup_lat, rides.pickup_lng, rides.destination_lat, rides.destination_lng,
         rides.flight_number, to_char(rides.flight_date, 'YYYY-MM-DD') AS flight_date, rides.passenger_surname,
         rides.pnr_masked, (rides.pnr_enc IS NOT NULL) AS has_pnr,
         rides.flight_tracking_state, rides.flight_tracking_reason, rides.flight_checked_at, rides.flight_eta,
         rides.booking_type, rides.vehicle_type, rides.fare_naira, rides.distance_km, rides.duration_min,
         rides.scheduled_pickup_at, rides.tracking_started_at, rides.completed_at, rides.created_at,
         rides.emergency_contact_name, rides.emergency_contact_phone, rides.admin_notes,
         riders.id as rider_id, riders.name as rider_name, riders.phone as rider_phone, riders.email as rider_email,
         driver_users.id as driver_user_id, driver_users.name as driver_name, driver_users.phone as driver_phone,
         vehicles.make_model, vehicles.plate_number,
         drivers.current_lat, drivers.current_lng, drivers.location_updated_at,
         (rides.panic_triggered_at IS NOT NULL AND rides.panic_resolved_at IS NULL) as has_active_panic
  FROM rides
  JOIN users riders ON riders.id = rides.rider_id
  LEFT JOIN drivers ON drivers.id = rides.driver_id
  LEFT JOIN users driver_users ON driver_users.id = drivers.user_id
  LEFT JOIN vehicles ON vehicles.id = drivers.vehicle_id
`;

const numOrNull = (v) => (v === null || v === undefined || v === "" || Number.isNaN(Number(v)) ? null : Number(v));

function shapeTrip(r) {
  let stops = [];
  try { stops = JSON.parse(r.stops || "[]"); } catch { stops = []; }
  return {
    ...r,
    stops,
    pickup_lat: numOrNull(r.pickup_lat),
    pickup_lng: numOrNull(r.pickup_lng),
    destination_lat: numOrNull(r.destination_lat),
    destination_lng: numOrNull(r.destination_lng),
    current_lat: numOrNull(r.current_lat),
    current_lng: numOrNull(r.current_lng),
    distance_km: numOrNull(r.distance_km),
    duration_min: numOrNull(r.duration_min),
  };
}

// Since #74 a list shows the last three digits of a number and nothing more.
// Full numbers come with one ride's detail, and that view is logged (below).
function hideTripNumbers(trip) {
  const { rider_email, rider_phone, driver_phone, emergency_contact_phone, ...rest } = trip;
  return {
    ...rest,
    rider_phone: null,
    driver_phone: null,
    emergency_contact_phone: null,
    rider_phone_hint: phoneHint(rider_phone),
    driver_phone_hint: phoneHint(driver_phone),
    emergency_contact_phone_hint: phoneHint(emergency_contact_phone),
    numbers_hidden: true,
  };
}

// Same record as GET /api/staff/rides/:id: one row per person, ride and kind of
// access in 10 minutes, so a refresh does not bury the log (staff_contact_access).
async function logNumberView(staffId, rideId, subjectUserId, subjectRole) {
  if (!subjectUserId) return;
  await pool.query(
    `INSERT INTO staff_contact_access (staff_user_id, ride_id, subject_user_id, subject_role, action)
     SELECT $1, $2, $3, $4, 'view_number'
     WHERE NOT EXISTS (
       SELECT 1 FROM staff_contact_access
       WHERE staff_user_id = $1 AND ride_id = $2 AND subject_user_id = $3 AND action = 'view_number'
         AND created_at > now() - interval '10 minutes')`,
    [staffId, rideId, subjectUserId, subjectRole]
  );
}

// One round trip for a whole sheet: every rider and driver number shown, deduped against the last 10 minutes.
async function logNumberViews(staffId, trips) {
  const rideIds = [], subjectIds = [], roles = [];
  for (const t of trips) {
    if (t.rider_id) { rideIds.push(t.id); subjectIds.push(t.rider_id); roles.push("rider"); }
    if (t.driver_phone && t.driver_user_id) { rideIds.push(t.id); subjectIds.push(t.driver_user_id); roles.push("driver"); }
  }
  if (!rideIds.length) return;
  try {
    await pool.query(
      `INSERT INTO staff_contact_access (staff_user_id, ride_id, subject_user_id, subject_role, action)
       SELECT $1, v.ride_id, v.subject_id, v.role, 'view_number'
       FROM unnest($2::int[], $3::int[], $4::text[]) AS v(ride_id, subject_id, role)
       WHERE v.subject_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM staff_contact_access s
         WHERE s.staff_user_id = $1 AND s.ride_id = v.ride_id AND s.subject_user_id = v.subject_id
           AND s.action = 'view_number' AND s.created_at > now() - interval '10 minutes')`,
      [staffId, rideIds, subjectIds, roles]
    );
  } catch (err) {
    console.error("dispatch-sheet audit write failed (sheet still served):", err.message);
  }
}

// GET /api/admin/trips/active
router.get("/trips/active", async (req, res) => {
  const result = await pool.query(
    `${TRIP_SELECT}
     WHERE rides.created_at > now() - interval '30 days'
       AND (rides.ride_status IN ('requested', 'accepted', 'in_progress')
            OR (rides.ride_status = 'completed' AND rides.completed_at > now() - interval '2 hours'))
     ORDER BY (rides.panic_triggered_at IS NOT NULL AND rides.panic_resolved_at IS NULL) DESC,
              CASE rides.ride_status WHEN 'in_progress' THEN 0 WHEN 'accepted' THEN 1 WHEN 'requested' THEN 2 ELSE 3 END,
              COALESCE(rides.scheduled_pickup_at, rides.created_at) ASC
     LIMIT 200`
  );
  res.json({ trips: result.rows.map((r) => hideTripNumbers(shapeTrip(r))), generatedAt: new Date().toISOString() });
});

// GET /api/admin/trips/dispatch-sheet
// The fallback if the console or the live map is down: every live ride with the
// full phone numbers on one page, to print or keep on a phone. It shows numbers,
// so each ride leaves the same trace as opening it (staff_contact_access).
// Declared before /trips/:id so "dispatch-sheet" is not read as a ride id.
router.get("/trips/dispatch-sheet", async (req, res) => {
  const result = await pool.query(
    `${TRIP_SELECT}
     WHERE rides.created_at > now() - interval '30 days'
       AND rides.ride_status IN ('requested', 'accepted', 'in_progress')
     ORDER BY (rides.panic_triggered_at IS NOT NULL AND rides.panic_resolved_at IS NULL) DESC,
              COALESCE(rides.scheduled_pickup_at, rides.created_at) ASC
     LIMIT 200`
  );
  const trips = result.rows.map(shapeTrip);
  // Record who saw which numbers, same trace as opening a ride and with the same 10 minute dedupe. This is the fallback
  // for when the console or live map is down, so the audit write is ONE statement on ONE connection (not up to 400
  // parallel inserts that would take the whole pool) and a failure is logged, never allowed to stop the page.
  await logNumberViews(req.user.id, trips);
  res.json({
    generatedAt: new Date().toISOString(),
    trips: trips.map((t) => ({
      id: t.id, status: t.ride_status, panic: !!t.has_active_panic,
      pickup: t.pickup_address, stops: t.stops, flight: t.flight_number,
      scheduledAt: t.scheduled_pickup_at, vehicle: t.vehicle_type,
      riderName: t.rider_name, riderPhone: t.rider_phone,
      emergencyName: t.emergency_contact_name, emergencyPhone: t.emergency_contact_phone,
      driverName: t.driver_name, driverPhone: t.driver_phone,
      car: [t.make_model, t.plate_number].filter(Boolean).join(" "),
    })),
  });
});

// Flight lookups are paid and quota-limited. services/flightLookup.js caches each flight and day
// (five minutes, ninety seconds while the plane is in the air), so many people with the page open
// still cost one query. It never throws, and "unknown" is a real answer shown to Ops.
async function cachedFlight(trip) {
  const looked = await lookupFlight({
    flightNumber: trip.flight_number, date: trip.flight_date || null,
    direction: trip.booking_type === "dropoff" ? "departure" : "arrival",
  });
  return {
    configured: looked.reason !== "no_provider",
    flight: looked.flight,
    error: looked.reason === "provider_error" ? "Flight lookup is temporarily unavailable." : null,
    tracking: { state: looked.state, label: looked.label, reason: looked.reason, delayMin: looked.delayMin ?? null },
    checkedAt: new Date().toISOString(),
  };
}

// GET /api/admin/trips/:id — one ride (any status) plus live flight status when it has a flight number.
router.get("/trips/:id", async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: "Invalid ride id" });
  const result = await pool.query(`${TRIP_SELECT} WHERE rides.id = $1`, [req.params.id]);
  if (!result.rows[0]) return res.status(404).json({ error: "Ride not found" });
  const trip = shapeTrip(result.rows[0]);
  // This view returns full numbers, so it leaves the same trace as the Ride Desk.
  if (trip.rider_phone || trip.rider_email || trip.emergency_contact_phone) await logNumberView(req.user.id, trip.id, trip.rider_id, "rider");
  if (trip.driver_phone) await logNumberView(req.user.id, trip.id, trip.driver_user_id, "driver");
  const flight = trip.flight_number ? await cachedFlight(trip) : null;
  res.json({ trip, flight });
});

// POST /api/admin/trips/:id/pnr: shows the booking code for one ride so support can confirm it with
// the airline. The code is encrypted at rest and never in a list or the trip payload; every reveal
// is recorded with who asked, the same trail as viewing a phone number.
router.post("/trips/:id/pnr", async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: "Invalid ride id" });
  const row = (await pool.query("SELECT id, rider_id, pnr_enc FROM rides WHERE id = $1", [req.params.id])).rows[0];
  if (!row) return res.status(404).json({ error: "Ride not found" });
  if (!row.pnr_enc) return res.status(404).json({ error: "No booking code was given for this ride." });
  let pnr;
  try { pnr = pnrVault.open(row.pnr_enc, row.id); }
  catch (err) {
    console.error(`[flight] PNR for ride #${row.id} could not be opened:`, err.message);
    return res.status(503).json({ error: "The booking code is unavailable right now." });
  }
  await pool.query(
    "INSERT INTO staff_contact_access (staff_user_id, ride_id, subject_user_id, subject_role, action) VALUES ($1, $2, $3, 'rider', 'view_pnr')",
    [req.user.id, row.id, row.rider_id]
  );
  res.set("Cache-Control", "no-store").json({ pnr });
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
//
// The ID photo is NOT in this list. users.id_document_url holds the whole image
// as a data URL (up to 6MB), so selecting it here put up to 200 riders' passport
// and NIN photos into one response, readable by every role that may open this
// list (including Operations, which is read only). The list carries a
// has_id_document flag instead; the image is fetched one rider at a time from
// GET /riders/:id/id-document below, which only admins can call.
router.get("/riders", async (req, res) => {
  const result = await pool.query(
    `SELECT users.id, users.name, users.email, users.phone, users.whatsapp_number, users.preferred_language, users.created_at,
            (users.id_document_url IS NOT NULL AND users.id_document_url <> '') AS has_id_document,
            users.id_verification_status, users.id_verification_submitted_at,
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

// GET /api/admin/riders/:id/id-document — the one rider's submitted ID photo,
// as an image. Admin only: it is the passport or NIN picture, so it is not
// something support or Operations can pull (Operations is also refused by the
// read-only allowlist, which only lets the exact /riders list path through).
// The console fetches it with its login token and shows it from a blob URL,
// because an <img src> cannot send an Authorization header.
//
// Only PNG, JPEG and WEBP are ever served, with the type fixed by us and
// nosniff, so a bad value in the column can never be handed to a browser as
// HTML or SVG. no-store keeps the photo out of any shared or browser cache.
router.get("/riders/:id/id-document", requireRole("admin"), async (req, res) => {
  if (!/^\d+$/.test(String(req.params.id))) return res.status(400).json({ error: "Invalid rider id" });
  const result = await pool.query(
    "SELECT id_document_url FROM users WHERE id = $1 AND role = 'rider' AND deleted_at IS NULL",
    [req.params.id]
  );
  const stored = result.rows[0]?.id_document_url;
  if (!stored) return res.status(404).json({ error: "No ID document on file for this rider" });
  const match = /^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=\s]+)$/.exec(stored);
  if (!match) return res.status(422).json({ error: "The stored ID document is not a readable image" });
  const type = match[1] === "png" ? "image/png" : match[1] === "webp" ? "image/webp" : "image/jpeg";
  res.set({
    "Content-Type": type,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-store",
    "Content-Disposition": "inline",
  });
  res.send(Buffer.from(match[2], "base64"));
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

// ── Cancelled flight credits (services/flightCredit.js) ───────────────────
// The fare of a cancelled arrival is kept as wallet credit. This is the Ops side: find a credit by
// rider name, passenger surname, email, phone, flight number or ride number, apply one by hand when
// the provider missed a cancellation, and move one to the account that should really have it.

router.get("/flight-credits", async (req, res) => {
  const rows = await flightCredit.searchCredits({ q: String(req.query.q || ""), status: req.query.status ? String(req.query.status) : null });
  // No credit ever expires on its own (that needs counsel). Held credits older than this many
  // days are flagged so a person contacts the rider. 0 turns the flag off.
  const n = Number(process.env.FLIGHT_CREDIT_REVIEW_DAYS);
  const reviewAfterDays = Number.isFinite(n) && n >= 0 ? Math.floor(n) : 180;
  res.json({ enabled: flightCredit.creditEnabled(), reviewAfterDays, credits: rows });
});

// Find the account a credit should go to: by name, email or phone.
router.get("/flight-credits/find-accounts", async (req, res) => {
  const words = flightCredit.nameKey(String(req.query.q || "")).split(" ").filter(Boolean).slice(0, 4);
  if (!words.length) return res.json({ accounts: [] });
  const params = [];
  const where = words.map((w) => {
    params.push(`%${w}%`);
    return `(lower(name) LIKE $${params.length} OR lower(email) LIKE $${params.length} OR coalesce(phone,'') LIKE $${params.length})`;
  });
  const r = await pool.query(`SELECT id, name, email, phone FROM users WHERE ${where.join(" AND ")} ORDER BY name LIMIT 20`, params);
  res.json({ accounts: r.rows });
});

router.post("/rides/:id/flight-credit", requireRole("admin"), async (req, res) => {
  if (!flightCredit.creditEnabled()) return res.status(409).json({ error: "Flight credit is switched off (FLIGHT_CANCEL_CREDIT)." });
  const result = await flightCredit.applyCredit(Number(req.params.id), { actorId: req.user.id, source: "ops" });
  if (!result.done) return res.status(409).json({ error: `Not credited: ${result.why}.` });
  res.json({ credited: true, amount: result.amount, creditId: result.creditId });
});

router.post("/flight-credits/:id/move", requireRole("admin"), async (req, res) => {
  const toUserId = Number(req.body?.toUserId);
  if (!Number.isInteger(toUserId) || toUserId <= 0) return res.status(400).json({ error: "toUserId is required." });
  const result = await flightCredit.moveCredit(Number(req.params.id), toUserId, { actorId: req.user.id, note: req.body?.note || "" });
  if (!result.done) {
    const why = { already_spent: "The rider has already spent this credit.", not_held: "This credit was already moved.", same_account: "That is the same account.", target_not_found: "No such account.", not_found: "No such credit." }[result.why] || result.why;
    return res.status(409).json({ error: why });
  }
  res.json({ moved: true, amount: result.amount });
});

module.exports = router;
