-- Arrivo database schema — PostgreSQL.
-- Migrated from the original SQLite version. Two syntax changes account for
-- almost the whole migration: SERIAL instead of AUTOINCREMENT, and now()
-- instead of datetime('now'). Everything else carried over unchanged.

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT,
  whatsapp_number TEXT,
  country_of_residence TEXT,
  passport_number TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'rider',        -- 'rider' | 'driver' | 'owner' | 'admin' | 'support' (support = read-only admin dashboard access, see scripts/create-support.js)
  agreed_to_terms BOOLEAN NOT NULL DEFAULT false,
  email_verified BOOLEAN NOT NULL DEFAULT false,
  email_verification_token TEXT,
  email_verification_expires TIMESTAMPTZ,
  preferred_language TEXT NOT NULL DEFAULT 'en',  -- 'en' | 'fr' | 'zh'
  reset_token TEXT,
  reset_token_expires TIMESTAMPTZ,
  avatar_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Adds the reset token columns if this table already existed before this
-- update (CREATE TABLE IF NOT EXISTS won't add columns to an existing table).
ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_expires TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS whatsapp_number TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS country_of_residence TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS passport_number TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS agreed_to_terms BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verification_token TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verification_expires TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS date_of_birth DATE;

-- Rider ID verification — previously a dead "Verified ID" label in the app
-- with no real flow behind it (no upload, no status, no review). A rider
-- submits a photo of their ID (id_document_url, same base64-data-URL
-- storage pattern as avatar_url — no cloud storage/file upload service
-- exists yet, see avatar_url above), which puts them in 'pending' for an
-- admin to review (see PATCH /api/admin/riders/:id/verify-id) and approve
-- or reject. Distinct from drivers.is_verified, which is a separate,
-- pre-existing flow gating whether a DRIVER can go online — this is the
-- rider-facing identity check shown on the Profile screen.
ALTER TABLE users ADD COLUMN IF NOT EXISTS id_document_url TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS id_verification_status TEXT NOT NULL DEFAULT 'unverified'; -- 'unverified' | 'pending' | 'verified' | 'rejected'
ALTER TABLE users ADD COLUMN IF NOT EXISTS id_verification_submitted_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS id_verification_reviewed_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS id_verification_rejection_reason TEXT;

CREATE TABLE IF NOT EXISTS vehicles (
  id SERIAL PRIMARY KEY,
  owner_user_id INTEGER NOT NULL REFERENCES users(id),
  make_model TEXT NOT NULL,
  plate_number TEXT NOT NULL,
  vehicle_type TEXT NOT NULL DEFAULT 'sedan', -- 'sedan' | 'suv' | 'truck' (Executive Vehicle) | 'pickup' (Pickup Truck, cargo)
  seats INTEGER DEFAULT 4,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Free-text availability set by the owner (e.g. "Mon-Fri 6am-9pm, weekends
-- blackout") — a simple note rather than a full scheduling table, since
-- there's no dispatcher/booking-by-availability logic built yet to consume
-- anything more structured.
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS availability_note TEXT;

CREATE TABLE IF NOT EXISTS drivers (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id),
  vehicle_id INTEGER REFERENCES vehicles(id),
  license_number TEXT,
  lasdri_number TEXT,
  spoken_languages TEXT NOT NULL DEFAULT 'en',
  is_verified BOOLEAN NOT NULL DEFAULT false,
  is_online BOOLEAN NOT NULL DEFAULT false,
  rating REAL DEFAULT 5.0,
  current_lat DOUBLE PRECISION,
  current_lng DOUBLE PRECISION,
  location_updated_at TIMESTAMPTZ,
  scan_token TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE drivers ADD COLUMN IF NOT EXISTS scan_token TEXT UNIQUE;

-- Added for the comprehensive driver application flow: insurance, vehicle
-- ownership (a driver may not own the car they drive — Arrivo's vehicle-owner
-- program means someone else could), verification photos, and a driver-side
-- emergency contact (the same safety feature riders already have).
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS insurance_number TEXT;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS vehicle_ownership TEXT NOT NULL DEFAULT 'self'; -- 'self' | 'other'
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS owner_name TEXT;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS owner_whatsapp TEXT;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS profile_photo_url TEXT;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS license_photo_url TEXT;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS vehicle_photo_url TEXT;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS emergency_contact_name TEXT;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS emergency_contact_phone TEXT;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS agreed_background_check BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS rides (
  id SERIAL PRIMARY KEY,
  rider_id INTEGER NOT NULL REFERENCES users(id),
  driver_id INTEGER REFERENCES drivers(id),
  pickup_address TEXT NOT NULL,
  stops TEXT,
  flight_number TEXT,
  vehicle_type TEXT,
  booking_type TEXT NOT NULL DEFAULT 'one_way',
  duration_days INTEGER NOT NULL DEFAULT 1,
  fare_naira INTEGER NOT NULL,
  payment_reference TEXT,
  payment_status TEXT NOT NULL DEFAULT 'pending',
  ride_status TEXT NOT NULL DEFAULT 'requested',
  agreed_cancellation_policy BOOLEAN NOT NULL DEFAULT false,
  tracking_started_at TIMESTAMPTZ,
  admin_notes TEXT,
  panic_triggered_at TIMESTAMPTZ,
  panic_resolved_at TIMESTAMPTZ,
  panic_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE rides ADD COLUMN IF NOT EXISTS agreed_cancellation_policy BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS tracking_started_at TIMESTAMPTZ;

-- Added for Uber-style distance-based pricing and the security escort /
-- fleet accompaniment add-ons. distance_km/duration_min are only populated
-- for one-way bookings priced by real route distance — day/week/month
-- bookings stay flat-rate and leave these null.
ALTER TABLE rides ADD COLUMN IF NOT EXISTS distance_km NUMERIC;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS duration_min NUMERIC;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS security_escort BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS fleet_size INTEGER NOT NULL DEFAULT 0;

-- Per-ride safety fields, matching the website's booking form: a contact
-- RideArrivo can reach if the rider can't be reached during the trip, and
-- consent for the in-vehicle dash cam (footage kept 30 days, then deleted).
ALTER TABLE rides ADD COLUMN IF NOT EXISTS emergency_contact_name TEXT;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS emergency_contact_phone TEXT;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS dash_cam_consent BOOLEAN NOT NULL DEFAULT false;

-- The rider's post-trip rating of their driver ("Rate & Relax" on the
-- website). Stored on the ride itself rather than a separate ratings
-- table, since it's one rating per completed trip. drivers.rating is
-- recomputed as the average of these whenever a new one comes in.
ALTER TABLE rides ADD COLUMN IF NOT EXISTS rider_rating INTEGER;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS rider_rating_comment TEXT;

-- Expo push token for this user's device, so the backend can send trip
-- status notifications (driver accepted, trip started, trip completed).
-- One token per user — simple last-device-wins, no multi-device fan-out.
ALTER TABLE users ADD COLUMN IF NOT EXISTS push_token TEXT;

-- "Listening device" toggle — matches the same setting shown on
-- ridearrivo.com's account page. Off by default; a rider opts in.
-- Superseded by the ride-scoped listening_device_* columns below, which
-- match what the website actually does (a one-way safety activation, not
-- a reversible preference). Left in place unused rather than dropped.
ALTER TABLE users ADD COLUMN IF NOT EXISTS audio_recording_enabled BOOLEAN NOT NULL DEFAULT false;

-- "Listening device" — a one-way safety activation per ride, matching
-- ridearrivo.com's real design: either the rider or the driver on a ride
-- can activate it directly, and triggering the panic button activates it
-- automatically too ("one trigger, full response"). There is deliberately
-- no deactivate path from the client — same "no manual reset" rule as
-- panic_triggered_at above; only an admin-cleared flag would close it out,
-- and that doesn't exist yet either.
ALTER TABLE rides ADD COLUMN IF NOT EXISTS listening_device_activated_at TIMESTAMPTZ;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS listening_device_via_panic BOOLEAN NOT NULL DEFAULT false;

-- Real pickup/destination coordinates, resolved from Google Place Details
-- when the rider picks an address from autocomplete (see routes/places.js).
-- Used to compute real driving distance/duration for the fare (see
-- services/fare.js + services/googleMaps.js) instead of the old approach
-- of matching keywords in a typed address string against a flat price
-- table. Only pickup + final destination are stored — an intermediate
-- stop doesn't get its own distance leg in this version; the fare is
-- based on the pickup-to-final-destination route.
ALTER TABLE rides ADD COLUMN IF NOT EXISTS pickup_lat NUMERIC;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS pickup_lng NUMERIC;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS destination_lat NUMERIC;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS destination_lng NUMERIC;

-- ── Wallet ──
-- A rider (or, later, a company on a delegate plan) can hold a balance and
-- pay for rides directly from it, as an alternative to per-trip card
-- payment. Every change to the balance is logged in wallet_transactions —
-- the balance column itself is a cached total, always re-derivable from
-- the transaction log, which is the actual source of truth.
ALTER TABLE users ADD COLUMN IF NOT EXISTS wallet_balance_naira NUMERIC NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS wallet_transactions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL, -- 'topup' | 'ride_charge' | 'credit' | 'refund' | 'membership_charge' | 'tip'
  status TEXT NOT NULL DEFAULT 'completed', -- 'pending' | 'completed' | 'failed'
  amount_naira NUMERIC NOT NULL, -- positive for topup/credit, negative for charges
  balance_after_naira NUMERIC, -- null while status = 'pending'
  paystack_reference TEXT UNIQUE, -- set for topups; UNIQUE stops the same Paystack payment being credited twice
  ride_id INTEGER REFERENCES rides(id),
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wallet_transactions_user ON wallet_transactions(user_id, created_at DESC);

-- ── Memberships ──
-- Two tracks: an individual paying one annual subscription instead of
-- per-trip, and a company subscribing once with multiple delegate riders
-- underneath it. company_account_id is null for the individual plan and
-- for the company's own membership row; delegate riders point it at the
-- company user's id.
CREATE TABLE IF NOT EXISTS memberships (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  plan_type TEXT NOT NULL, -- 'individual_annual' | 'corporate_delegate'
  status TEXT NOT NULL DEFAULT 'active', -- 'active' | 'cancelled' | 'expired'
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  price_naira NUMERIC NOT NULL,
  company_account_id INTEGER REFERENCES users(id), -- set on a delegate rider, pointing at the company's user row
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_memberships_company ON memberships(company_account_id);


CREATE TABLE IF NOT EXISTS waitlist (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  source TEXT DEFAULT 'website',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rides_panic_active
  ON rides (panic_triggered_at)
  WHERE panic_triggered_at IS NOT NULL AND panic_resolved_at IS NULL;

-- "Reserve now, pay at pickup" — DEPRECATED. This used to let a rider
-- reserve a one-way ride and pay the fare later (debited from wallet at
-- the pickup QR scan) instead of at booking. Removed as a product
-- decision: every ride is now paid in full at booking, like a plane
-- ticket, never at the end of the trip. routes/rides.js POST / rejects any
-- new attempt to set pay_at_pickup. The column (and the routes/rides.js
-- scan-time-charge code that reads it) is kept only so any ride that was
-- already reserved-unpaid before this change shipped still settles
-- correctly — it should always be false for anything created afterward.
-- payment_method is still stored on every ride (independent of
-- pay_at_pickup) so it's visible which rail actually settled the fare.
ALTER TABLE rides ADD COLUMN IF NOT EXISTS pay_at_pickup BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS payment_method TEXT;

-- Driver tipping — optional, prompted after a ride is marked 'completed'
-- (alongside the rider-rating prompt). Riders never tip in cash, so this
-- goes through the same rails as the fare itself (wallet debit or a fresh
-- card charge — see POST /api/rides/:id/tip). One tip per ride; tip_naira
-- stays 0 until (and unless) the rider adds one.
ALTER TABLE rides ADD COLUMN IF NOT EXISTS tip_naira NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS tip_payment_method TEXT;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS tip_payment_reference TEXT;

-- Airport Drop-off — RideArrivo taking a departing rider FROM their
-- location TO the airport, the mirror image of the existing 'one_way'
-- arrival pickup. booking_type = 'dropoff' is priced with the exact same
-- per-location formula as 'one_way' (see services/fare.js), just kept as
-- its own value so ride history/driver instructions/reporting can tell the
-- two apart. scheduled_pickup_at is required for 'dropoff' bookings (there's
-- no flight-landing event to anchor timing the way an arrival pickup has —
-- the rider tells us directly when they need picking up) and optional for
-- everything else. linked_ride_id optionally pairs a drop-off with the
-- arrival pickup it was booked alongside in the same session (a
-- round-trip-style booking, "if they know their expected time and day of
-- return, book it at once") — display/reporting only, doesn't affect
-- pricing or dispatch.
ALTER TABLE rides ADD COLUMN IF NOT EXISTS scheduled_pickup_at TIMESTAMPTZ;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS linked_ride_id INTEGER REFERENCES rides(id);

-- ── Driver/vehicle continuity for return trips ──
-- At "Rate & Relax" after a completed arrival pickup, a rider can say
-- "keep the same driver and vehicle for my return trip." That preference is
-- stored on the RATED ride (keep_same_driver_for_return); when a 'dropoff'
-- ride later gets created with linked_ride_id pointing at this one, the
-- backend copies driver_id/vehicle info across as preferred_driver_id +
-- preferred_vehicle_snapshot (a plain text snapshot like "Toyota Camry —
-- ABC123XY", not a live FK to vehicles, since the driver's assigned vehicle
-- could change between now and then and the snapshot is just informational
-- context for the rider/driver, not something dispatch re-resolves).
-- preferred_driver_id references drivers(id) (not users(id)) to match
-- rides.driver_id's own convention.
ALTER TABLE rides ADD COLUMN IF NOT EXISTS keep_same_driver_for_return BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS preferred_driver_id INTEGER REFERENCES drivers(id);
ALTER TABLE rides ADD COLUMN IF NOT EXISTS preferred_vehicle_snapshot TEXT;
-- Set (and shown to the rider) if a preferred driver couldn't be retained —
-- e.g. the claim window elapsed with no response, or they went offline —
-- so "your driver changed" never arrives as a silent surprise.
ALTER TABLE rides ADD COLUMN IF NOT EXISTS driver_change_reason TEXT;

-- ── Flight cancellation/reschedule handling ──
-- original_flight_scheduled_at captures the flight's scheduled time AT
-- BOOKING TIME (best-effort, from GET /api/flights/status) purely so a
-- later background check can tell "rescheduled" (the time drifted a lot)
-- apart from "always been like this." flight_issue is null until the
-- scheduler (services/scheduler.js) detects a real cancellation/reschedule;
-- once set, PATCH /:id/status re-applies the existing $100-equivalent
-- standing-wallet-balance rule (see MIN_WALLET_BALANCE_USD in routes/rides.js)
-- as a gate on starting the trip, and — since the original upfront charge
-- gets refunded back to the wallet the moment the issue is detected — the
-- actual fare is charged from the wallet again at trip completion instead
-- of having already been settled at booking.
ALTER TABLE rides ADD COLUMN IF NOT EXISTS original_flight_scheduled_at TIMESTAMPTZ;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS flight_issue TEXT; -- null | 'cancelled' | 'rescheduled'
ALTER TABLE rides ADD COLUMN IF NOT EXISTS flight_issue_notified_at TIMESTAMPTZ;

-- ── Pickup/drop-off reminders ──
-- One boolean per threshold so the scheduler's periodic sweep (every few
-- minutes) never double-sends a reminder it already fired for a given ride.
-- Applies to both 'dropoff' rides (anchored on scheduled_pickup_at) and
-- 'one_way' rides (anchored on the flight's live estimated/scheduled
-- arrival time, refreshed by the same sweep).
ALTER TABLE rides ADD COLUMN IF NOT EXISTS reminder_5h_sent BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS reminder_3h_sent BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS reminder_1h_sent BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS reminder_now_sent BOOLEAN NOT NULL DEFAULT false;

-- Passenger count (adults/children) and the vehicleCount that was actually
-- charged for (see services/fare.js computeVehicleCount) — a group bigger
-- than one vehicle's seats books multiple of the same vehicle type instead
-- of being blocked, and vehicle_count is what the fare above was multiplied
-- by. Defaults keep every existing/charter ride (which never collected a
-- passenger count) reading as "1 adult, 0 children, 1 vehicle" — accurate
-- for all of them.
ALTER TABLE rides ADD COLUMN IF NOT EXISTS adults INTEGER NOT NULL DEFAULT 1;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS children INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS vehicle_count INTEGER NOT NULL DEFAULT 1;
