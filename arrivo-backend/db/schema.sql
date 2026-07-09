-- Arrivo database schema — PostgreSQL.
-- Migrated from the original SQLite version. Two syntax changes account for
-- almost the whole migration: SERIAL instead of AUTOINCREMENT, and now()
-- instead of datetime('now'). Everything else carried over unchanged.

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'rider',        -- 'rider' | 'driver' | 'owner' | 'admin'
  preferred_language TEXT NOT NULL DEFAULT 'en',  -- 'en' | 'fr' | 'zh'
  reset_token TEXT,
  reset_token_expires TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Adds the reset token columns if this table already existed before this
-- update (CREATE TABLE IF NOT EXISTS won't add columns to an existing table).
ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_expires TIMESTAMPTZ;

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
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

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
  admin_notes TEXT,
  panic_triggered_at TIMESTAMPTZ,
  panic_resolved_at TIMESTAMPTZ,
  panic_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS waitlist (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  source TEXT DEFAULT 'website',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rides_panic_active
  ON rides (panic_triggered_at)
  WHERE panic_triggered_at IS NOT NULL AND panic_resolved_at IS NULL;
