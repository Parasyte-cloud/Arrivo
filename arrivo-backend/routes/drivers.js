const express = require("express");
const crypto = require("crypto");
const { pool } = require("../db/db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { validateImageDataUrl } = require("../services/imageValidation");

const MAX_DOCUMENT_PHOTO_BYTES = 6 * 1024 * 1024; // 6MB — matches the 6MB cap already enforced client-side

const router = express.Router();

async function getDriverForUser(userId) {
  const result = await pool.query("SELECT * FROM drivers WHERE user_id = $1", [userId]);
  return result.rows[0];
}

async function getDriverWithVehicle(userId) {
  const result = await pool.query(
    `SELECT drivers.*, users.name, users.email, users.phone,
            vehicles.make_model, vehicles.plate_number, vehicles.vehicle_type, vehicles.seats
     FROM drivers
     JOIN users ON users.id = drivers.user_id
     LEFT JOIN vehicles ON vehicles.id = drivers.vehicle_id
     WHERE drivers.user_id = $1`,
    [userId]
  );
  return result.rows[0];
}

// POST /api/drivers/profile — create or update the driver + vehicle profile
router.post("/profile", requireAuth, requireRole("driver"), async (req, res) => {
  const {
    licenseNumber, lasdriNumber, spokenLanguages = "en", vehicle,
    insuranceNumber, vehicleOwnership = "self", ownerName, ownerWhatsapp,
  } = req.body;

  if (vehicleOwnership === "other" && (!ownerName || !ownerWhatsapp)) {
    return res.status(400).json({ error: "Owner's name and WhatsApp number are required when the vehicle isn't yours." });
  }

  let vehicleId = null;
  const existingDriver = await getDriverForUser(req.user.id);

  if (vehicle?.makeModel && vehicle?.plateNumber) {
    if (existingDriver?.vehicle_id) {
      await pool.query(
        `UPDATE vehicles SET make_model = $1, plate_number = $2, vehicle_type = $3, seats = $4 WHERE id = $5`,
        [vehicle.makeModel, vehicle.plateNumber, vehicle.vehicleType || "sedan", vehicle.seats || 4, existingDriver.vehicle_id]
      );
      vehicleId = existingDriver.vehicle_id;
    } else {
      const inserted = await pool.query(
        `INSERT INTO vehicles (owner_user_id, make_model, plate_number, vehicle_type, seats)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [req.user.id, vehicle.makeModel, vehicle.plateNumber, vehicle.vehicleType || "sedan", vehicle.seats || 4]
      );
      vehicleId = inserted.rows[0].id;
    }
  }

  if (existingDriver) {
    await pool.query(
      `UPDATE drivers SET license_number = $1, lasdri_number = $2, spoken_languages = $3, vehicle_id = COALESCE($4, vehicle_id),
              insurance_number = $5, vehicle_ownership = $6, owner_name = $7, owner_whatsapp = $8
       WHERE user_id = $9`,
      [
        licenseNumber || existingDriver.license_number, lasdriNumber || existingDriver.lasdri_number, spokenLanguages, vehicleId,
        insuranceNumber || existingDriver.insurance_number, vehicleOwnership,
        vehicleOwnership === "other" ? ownerName : null, vehicleOwnership === "other" ? ownerWhatsapp : null,
        req.user.id,
      ]
    );
  } else {
    // scan_token is generated once, permanently, the day a driver's profile
    // is created — this is what gets encoded into their placard's QR code,
    // so it must never change afterward or every printed placard breaks.
    const scanToken = crypto.randomBytes(16).toString("hex");
    await pool.query(
      `INSERT INTO drivers (user_id, vehicle_id, license_number, lasdri_number, spoken_languages, scan_token,
                             insurance_number, vehicle_ownership, owner_name, owner_whatsapp)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        req.user.id, vehicleId, licenseNumber || null, lasdriNumber || null, spokenLanguages, scanToken,
        insuranceNumber || null, vehicleOwnership,
        vehicleOwnership === "other" ? ownerName : null, vehicleOwnership === "other" ? ownerWhatsapp : null,
      ]
    );
  }

  res.status(201).json({ driver: await getDriverWithVehicle(req.user.id) });
});

// GET /api/drivers/me
router.get("/me", requireAuth, requireRole("driver"), async (req, res) => {
  const driver = await getDriverWithVehicle(req.user.id);
  if (!driver) return res.status(404).json({ error: "No driver profile yet — complete it via POST /api/drivers/profile" });
  res.json({ driver });
});

// PATCH /api/drivers/me — everything a driver edits about themself after
// their initial application: profile/license/vehicle photos, their own
// WhatsApp number (stored on users, not drivers), and their emergency
// contact + background-check consent. Each field is independently
// optional so the web signup wizard can call this once per step without
// needing to resend fields from earlier steps.
router.patch("/me", requireAuth, requireRole("driver"), async (req, res) => {
  const {
    profilePhotoDataUrl, licensePhotoDataUrl, vehiclePhotoDataUrl,
    whatsappNumber, emergencyContactName, emergencyContactPhone,
    agreedBackgroundCheck, agreedTerms,
  } = req.body;

  const driver = await getDriverForUser(req.user.id);
  if (!driver) return res.status(404).json({ error: "Complete your driver profile first via POST /api/drivers/profile" });

  for (const [dataUrl, label] of [
    [profilePhotoDataUrl, "Profile photo"],
    [licensePhotoDataUrl, "Driver's license photo"],
    [vehiclePhotoDataUrl, "Vehicle photo"],
  ]) {
    const err = validateImageDataUrl(dataUrl, label, MAX_DOCUMENT_PHOTO_BYTES);
    if (err) return res.status(400).json({ error: err });
  }

  await pool.query(
    `UPDATE drivers SET
       profile_photo_url = COALESCE($1, profile_photo_url),
       license_photo_url = COALESCE($2, license_photo_url),
       vehicle_photo_url = COALESCE($3, vehicle_photo_url),
       emergency_contact_name = COALESCE($4, emergency_contact_name),
       emergency_contact_phone = COALESCE($5, emergency_contact_phone),
       agreed_background_check = COALESCE($6, agreed_background_check)
     WHERE user_id = $7`,
    [
      profilePhotoDataUrl || null, licensePhotoDataUrl || null, vehiclePhotoDataUrl || null,
      emergencyContactName || null, emergencyContactPhone || null,
      agreedBackgroundCheck === true ? true : null,
      req.user.id,
    ]
  );

  if (whatsappNumber || agreedTerms === true) {
    await pool.query(
      `UPDATE users SET
         whatsapp_number = COALESCE($1, whatsapp_number),
         agreed_to_terms = COALESCE($2, agreed_to_terms)
       WHERE id = $3`,
      [whatsappNumber || null, agreedTerms === true ? true : null, req.user.id]
    );
  }

  res.json({ driver: await getDriverWithVehicle(req.user.id) });
});

// PATCH /api/drivers/status — toggle online/offline. Blocked unless verified.
router.patch("/status", requireAuth, requireRole("driver"), async (req, res) => {
  const driver = await getDriverForUser(req.user.id);
  if (!driver) return res.status(404).json({ error: "Complete your driver profile first" });

  if (req.body.isOnline && !driver.is_verified) {
    return res.status(403).json({ error: "Your account isn't verified yet. An admin needs to approve your driver profile before you can go online." });
  }

  await pool.query("UPDATE drivers SET is_online = $1 WHERE id = $2", [!!req.body.isOnline, driver.id]);
  res.json({ isOnline: !!req.body.isOnline });
});

// PATCH /api/drivers/location — the driver's phone posts its GPS coordinates
// here periodically while online. This is what lets a rider's tracking
// screen and the admin dashboard show a real live position instead of a
// stylized placeholder.
router.patch("/location", requireAuth, requireRole("driver"), async (req, res) => {
  const { lat, lng } = req.body;
  if (typeof lat !== "number" || typeof lng !== "number") {
    return res.status(400).json({ error: "lat and lng must both be numbers" });
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return res.status(400).json({ error: "lat/lng out of valid range" });
  }

  const driver = await getDriverForUser(req.user.id);
  if (!driver) return res.status(404).json({ error: "Complete your driver profile first" });

  await pool.query(
    "UPDATE drivers SET current_lat = $1, current_lng = $2, location_updated_at = now() WHERE id = $3",
    [lat, lng, driver.id]
  );
  res.json({ ok: true });
});

// GET /api/drivers/earnings
router.get("/earnings", requireAuth, requireRole("driver"), async (req, res) => {
  const driver = await getDriverForUser(req.user.id);
  if (!driver) return res.status(404).json({ error: "Complete your driver profile first" });

  // completedTrips previously counted every completed ride, including Fleet
  // Accompaniment escort companions — those always have fare_naira = 0 (the
  // rider already paid for the whole convoy on the primary ride's fare, see
  // createFleetCompanions in routes/rides.js), so counting them here made a
  // driver's trip count look inflated relative to what they actually earned
  // (e.g. "50 trips" when several paid nothing). Split out separately so
  // completedTrips stays a meaningful "trips that paid you" figure, without
  // hiding the real driving work behind completedFleetEscortTrips.
  const summary = (
    await pool.query(
      `SELECT COUNT(*) FILTER (WHERE NOT is_fleet_companion) as "completedTrips",
              COUNT(*) FILTER (WHERE is_fleet_companion) as "completedFleetEscortTrips",
              COALESCE(SUM(fare_naira), 0) as "totalNaira",
              COALESCE(SUM(tip_naira), 0) as "totalTipsNaira",
              COALESCE(SUM(escort_payout_naira), 0) as "totalEscortPayoutNaira"
       FROM rides WHERE driver_id = $1 AND ride_status = 'completed'`,
      [driver.id]
    )
  ).rows[0];

  const thisMonth = (
    await pool.query(
      `SELECT COALESCE(SUM(fare_naira), 0) as "totalNaira",
              COALESCE(SUM(tip_naira), 0) as "totalTipsNaira",
              COALESCE(SUM(escort_payout_naira), 0) as "totalEscortPayoutNaira"
       FROM rides WHERE driver_id = $1 AND ride_status = 'completed'
       AND date_trunc('month', created_at) = date_trunc('month', now())`,
      [driver.id]
    )
  ).rows[0];

  res.json({
    completedTrips: Number(summary.completedTrips),
    completedFleetEscortTrips: Number(summary.completedFleetEscortTrips),
    // totalNaira/thisMonthNaira include tips AND the flat fleet-escort
    // payout (what the driver actually earned in total); totalTipsNaira/
    // totalEscortPayoutNaira (and their thisMonth equivalents) break those
    // out separately so the app can show "of which ₦X was tips/escort pay"
    // rather than hiding them inside one lump sum.
    totalNaira: Number(summary.totalNaira) + Number(summary.totalTipsNaira) + Number(summary.totalEscortPayoutNaira),
    totalTipsNaira: Number(summary.totalTipsNaira),
    totalEscortPayoutNaira: Number(summary.totalEscortPayoutNaira),
    thisMonthNaira: Number(thisMonth.totalNaira) + Number(thisMonth.totalTipsNaira) + Number(thisMonth.totalEscortPayoutNaira),
    thisMonthTipsNaira: Number(thisMonth.totalTipsNaira),
    thisMonthEscortPayoutNaira: Number(thisMonth.totalEscortPayoutNaira),
  });
});

module.exports = { router, getDriverForUser, getDriverWithVehicle };
