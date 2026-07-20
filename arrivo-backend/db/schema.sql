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

CREATE TABLE IF NOT EXISTS vehicles (
  id SERIAL PRIMARY KEY,
  owner_user_id INTEGER NOT NULL REFERENCES users(id),
  make_model TEXT NOT NULL,
  plate_number TEXT NOT NULL,
  vehicle_type TEXT NOT NULL DEFAULT 'sedan', -- 'sedan' | 'suv' | 'truck'
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
ALTER TABLE users ADD COLUMN IF NOT EXISTS audio_recording_enabled BOOLEAN NOT NULL DEFAULT false;

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
  type TEXT NOT NULL, -- 'topup' | 'ride_charge' | 'credit' | 'refund' | 'membership_charge'
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
