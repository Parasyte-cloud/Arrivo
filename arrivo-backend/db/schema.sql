-- Arrivo database schema.
-- Written in plain, portable SQL — works as-is with SQLite (used here for
-- zero-setup local dev) and needs only minor tweaks for PostgreSQL later
-- (see the note at the bottom of this file).

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'rider',        -- 'rider' | 'driver' | 'owner' | 'admin'
  preferred_language TEXT NOT NULL DEFAULT 'en',  -- 'en' | 'fr' (add more as you support them)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS vehicles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_user_id INTEGER NOT NULL REFERENCES users(id),
  make_model TEXT NOT NULL,
  plate_number TEXT NOT NULL,
  vehicle_type TEXT NOT NULL DEFAULT 'sedan', -- 'sedan' | 'suv' | 'truck'
  seats INTEGER DEFAULT 4,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS drivers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id),
  vehicle_id INTEGER REFERENCES vehicles(id),
  license_number TEXT,
  lasdri_number TEXT,
  spoken_languages TEXT NOT NULL DEFAULT 'en', -- comma-separated: "en,fr"
  is_verified INTEGER NOT NULL DEFAULT 0,       -- 0/1 boolean
  is_online INTEGER NOT NULL DEFAULT 0,         -- 0/1 boolean — driver's own toggle
  rating REAL DEFAULT 5.0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rider_id INTEGER NOT NULL REFERENCES users(id),
  driver_id INTEGER REFERENCES drivers(id),
  pickup_address TEXT NOT NULL,
  stops TEXT,                     -- JSON array of extra stops, stored as text
  flight_number TEXT,
  vehicle_type TEXT,
  fare_naira INTEGER NOT NULL,
  payment_reference TEXT,
  payment_status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'paid' | 'failed'
  ride_status TEXT NOT NULL DEFAULT 'requested',  -- 'requested' | 'accepted' | 'in_progress' | 'completed' | 'cancelled'
  admin_notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Moving to PostgreSQL later ──────────────────────────────────────────
-- Two changes needed:
--   1. Replace "INTEGER PRIMARY KEY AUTOINCREMENT" with "SERIAL PRIMARY KEY"
--   2. Replace "datetime('now')" with "now()"
-- Everything else (column types, REFERENCES, table structure) works unchanged.
