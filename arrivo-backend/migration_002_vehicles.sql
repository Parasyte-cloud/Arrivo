-- CORRECTED from an earlier draft that mistakenly created a competing
-- `vehicles` table, not having yet inspected the real schema. The real
-- one already exists (owner_user_id, make_model, plate_number,
-- vehicle_type, seats), created for the vehicle-owner-lending flow, and
-- is linked via drivers.vehicle_id — a driver has one assigned vehicle,
-- not a ride having a direct vehicle column. This migration only adds
-- what's genuinely missing for fleet-tracking purposes, non-destructively.

ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'AVAILABLE';
-- AVAILABLE | ASSIGNED | EN_ROUTE_TO_PICKUP | AT_PICKUP | RIDER_ONBOARD
-- | EN_ROUTE_TO_DESTINATION | COMPLETED | OFFLINE | GPS_STALE | ALERT | MAINTENANCE
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;

-- Vehicle hardware tracker readiness — unchanged in intent from the
-- earlier draft, just correctly pointing at the real vehicles table.
CREATE TABLE IF NOT EXISTS vehicle_trackers (
  id SERIAL PRIMARY KEY,
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_device_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  last_seen_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_device_id)
);

-- Deliberately NOT adding rides.vehicle_id. A ride's vehicle is already
-- derivable via rides.driver_id -> drivers.vehicle_id -> vehicles.id,
-- exactly the pattern already used throughout routes/admin.js,
-- routes/drivers.js, and routes/rides.js. Adding a second, direct
-- vehicle reference on rides would create two sources of truth that
-- could silently drift out of sync if a driver's assigned vehicle
-- changes mid-ride.
