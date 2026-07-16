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


CREATE TABLE IF NOT EXISTS waitlist (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  source TEXT DEFAULT 'website',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rides_panic_active
  ON rides (panic_triggered_at)
  WHERE panic_triggered_at IS NOT NULL AND panic_resolved_at IS NULL;
