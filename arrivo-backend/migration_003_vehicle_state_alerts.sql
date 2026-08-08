-- Current vehicle state (spec section 5) — fast-read table, separate
-- from ride_telemetry history. One row per vehicle, upserted on every
-- accepted telemetry sample. The Live Map reads this table, never the
-- full history table.
CREATE TABLE IF NOT EXISTS vehicle_current_state (
  vehicle_id INTEGER PRIMARY KEY REFERENCES vehicles(id) ON DELETE CASCADE,
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  speed_kmh DOUBLE PRECISION,
  heading_deg DOUBLE PRECISION,
  accuracy_m DOUBLE PRECISION,
  source TEXT,
  recorded_at TIMESTAMPTZ,
  gps_health TEXT, -- FRESH | AGING | STALE | OFFLINE
  current_ride_id INTEGER REFERENCES rides(id),
  current_driver_id INTEGER REFERENCES drivers(id),
  route_state TEXT, -- mirrors route_deviation_state.state for this vehicle's active ride, if any
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vehicle_state_ride ON vehicle_current_state (current_ride_id);
CREATE INDEX IF NOT EXISTS idx_vehicle_state_gps_health ON vehicle_current_state (gps_health);

-- Alert notes need to support append-only growth (Ops adding
-- observations over time) — safety_alerts.notes already exists from
-- migration_001 as plain TEXT, which supports this via the
-- COALESCE(notes || E'\n', '') || $new pattern used in alertService.js.
-- No schema change needed here, noted for completeness.
