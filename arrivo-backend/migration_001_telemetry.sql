-- Fleet & Ride Safety Tracking — Phase 1 schema
--
-- Design principle: telemetry is a persisted time series (INSERT-only),
-- never overwritten in place. The existing drivers.current_lat/lng stays
-- as-is for now — it's a cheap "last known position" cache other queries
-- already depend on — but it is no longer the source of truth. This table
-- is. That's what makes a timeline (spec section 14) and an audit trail
-- (section 26) possible at all, which the current schema cannot do.
--
-- "source" is deliberately a free column, not hardcoded to "driver_phone",
-- so a vehicle hardware tracker can write into this exact same table the
-- day one is actually integrated — no schema change needed later, only a
-- new ingestion endpoint.

CREATE TABLE IF NOT EXISTS ride_telemetry (
  id BIGSERIAL PRIMARY KEY,
  ride_id INTEGER NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
  source TEXT NOT NULL DEFAULT 'driver_phone', -- 'driver_phone' | 'vehicle_tracker' (future)
  lat DOUBLE PRECISION NOT NULL,
  lng DOUBLE PRECISION NOT NULL,
  accuracy_m DOUBLE PRECISION, -- GPS accuracy radius in meters, if the device reports it
  speed_kmh DOUBLE PRECISION,
  heading_deg DOUBLE PRECISION, -- compass heading 0-360, if available
  recorded_at TIMESTAMPTZ NOT NULL, -- when the device captured this fix (not when it reached the server)
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(), -- when the server actually received it — the gap between the two matters for staleness math
  CHECK (lat BETWEEN -90 AND 90),
  CHECK (lng BETWEEN -180 AND 180)
);

-- The two lookups every part of this system does constantly: "give me
-- this ride's recent telemetry in order" and "how much telemetry are we
-- storing overall" (for the retention job in migration_002).
CREATE INDEX IF NOT EXISTS idx_ride_telemetry_ride_time ON ride_telemetry (ride_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_ride_telemetry_received ON ride_telemetry (received_at);

-- Route persistence (spec section 5) — calculated once when a ride
-- starts, not regenerated on every telemetry tick. geometry is stored as
-- plain JSON (an array of [lat,lng] points), not PostGIS, since nothing
-- else in this stack currently uses PostGIS and introducing it is its own
-- decision, not a silent side effect of this feature.
ALTER TABLE rides ADD COLUMN IF NOT EXISTS route_geometry JSONB;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS route_distance_km DOUBLE PRECISION;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS route_duration_min DOUBLE PRECISION;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS route_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS route_generated_at TIMESTAMPTZ;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS route_provider TEXT; -- which routing API generated it — filled in once section 5's provider decision is made

-- Route-deviation state machine (spec sections 6 & 8). One row per ride
-- that's ever had telemetry evaluated — updated in place as the state
-- machine transitions, not re-inserted, so "how long has this ride been
-- in its current state" is a simple timestamp diff.
CREATE TABLE IF NOT EXISTS route_deviation_state (
  ride_id INTEGER PRIMARY KEY REFERENCES rides(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'ON_ROUTE', -- ON_ROUTE | POSSIBLE_DEVIATION | OFF_ROUTE | PERSISTENT_OFF_ROUTE | CRITICAL_ROUTE_DEVIATION
  distance_from_route_m DOUBLE PRECISION,
  distance_from_destination_km DOUBLE PRECISION,
  state_entered_at TIMESTAMPTZ NOT NULL DEFAULT now(), -- when it entered the CURRENT state — this is what "persistence" (section 6C) is measured against
  last_evaluated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  consecutive_off_route_samples INTEGER NOT NULL DEFAULT 0
);

-- Every state transition, permanently — this is the ride timeline (spec
-- section 14) and the audit trail (spec section 26) in one table.
CREATE TABLE IF NOT EXISTS route_deviation_events (
  id BIGSERIAL PRIMARY KEY,
  ride_id INTEGER NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
  from_state TEXT,
  to_state TEXT NOT NULL,
  distance_from_route_m DOUBLE PRECISION,
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  gps_accuracy_m DOUBLE PRECISION,
  note TEXT, -- e.g. "GPS accuracy too poor to evaluate", "returned to route after 47s"
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_deviation_events_ride ON route_deviation_events (ride_id, created_at);

-- Alert Center (spec section 9-10). Deliberately generic across alert
-- types (not just route deviation) so SOS, GPS staleness, and future
-- driver/vehicle mismatch alerts all live in one place Ops actually
-- checks, rather than scattered across different UI panels.
CREATE TABLE IF NOT EXISTS safety_alerts (
  id BIGSERIAL PRIMARY KEY,
  ride_id INTEGER REFERENCES rides(id) ON DELETE CASCADE,
  severity TEXT NOT NULL, -- CRITICAL | HIGH | MEDIUM | LOW
  type TEXT NOT NULL, -- ROUTE_DEVIATION | DESTINATION_DEVIATION | GPS_STALE | PANIC | ...
  status TEXT NOT NULL DEFAULT 'OPEN', -- OPEN | ACKNOWLEDGED | INVESTIGATING | RESOLVED | DISMISSED
  current_lat DOUBLE PRECISION,
  current_lng DOUBLE PRECISION,
  distance_from_route_m DOUBLE PRECISION,
  distance_from_destination_km DOUBLE PRECISION,
  speed_kmh DOUBLE PRECISION,
  heading_deg DOUBLE PRECISION,
  gps_accuracy_m DOUBLE PRECISION,
  notes TEXT, -- Ops-entered notes (section 10) — append-only in the API layer, not overwritten
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  acknowledged_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  auto_resolved BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_safety_alerts_status ON safety_alerts (status, severity);
CREATE INDEX IF NOT EXISTS idx_safety_alerts_ride ON safety_alerts (ride_id);
