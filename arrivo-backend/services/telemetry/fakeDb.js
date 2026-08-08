// A minimal in-memory fake implementing the same { query(sql, params) }
// interface the real pg pool uses, matching only the specific queries
// telemetryService.js and its collaborators actually issue. Not a
// general SQL engine — a pragmatic, honest testing tool. Its purpose is
// proving the modules built across phases 1-3 genuinely wire together
// correctly, which isolated unit tests cannot show on their own.
function createFakeDb(initial = {}) {
  const state = {
    rides: initial.rides || [],
    ride_telemetry: [],
    route_deviation_state: {}, // keyed by ride_id
    route_deviation_events: [],
    safety_alerts: [],
    vehicle_current_state: {}, // keyed by vehicle_id
    _nextAlertId: 1,
  };

  async function query(sql, params = []) {
    const s = sql.replace(/\s+/g, " ").trim();

    if (s.startsWith("INSERT INTO ride_telemetry")) {
      state.ride_telemetry.push({ ride_id: params[0], source: params[1], lat: params[2], lng: params[3], accuracy_m: params[4], speed_kmh: params[5], heading_deg: params[6], recorded_at: params[7] });
      return { rows: [] };
    }

    if (s.startsWith("SELECT lat, lng, recorded_at")) {
      // getLastTelemetry — simplified: just the most recent row overall in this fake, fine for single-vehicle test scenarios
      const rows = state.ride_telemetry.slice().sort((a, b) => new Date(b.recorded_at) - new Date(a.recorded_at));
      return { rows: rows[0] ? [{ lat: rows[0].lat, lng: rows[0].lng, recordedAt: rows[0].recorded_at }] : [] };
    }

    if (s.startsWith("SELECT id, route_geometry")) {
      const driverId = params[0];
      const ride = state.rides.find((r) => r.driver_id === driverId && ["accepted", "in_progress"].includes(r.ride_status));
      if (!ride) return { rows: [] };
      return { rows: [{ id: ride.id, routeGeometry: ride.route_geometry, routeVersion: ride.route_version, routeGeneratedAt: ride.route_generated_at, dropoff_lat: ride.dropoff_lat, dropoff_lng: ride.dropoff_lng }] };
    }

    if (s.startsWith("SELECT state, distance_from_route_m")) {
      const rideId = params[0];
      const st = state.route_deviation_state[rideId];
      return { rows: st ? [st] : [] };
    }

    if (s.startsWith("INSERT INTO route_deviation_state")) {
      const [rideId, st8, distM, distKm, enteredAt, samples] = params;
      state.route_deviation_state[rideId] = { state: st8, distanceFromRouteM: distM, distanceFromDestinationKm: distKm, stateEnteredAt: enteredAt, consecutiveOffRouteSamples: samples };
      return { rows: [] };
    }

    if (s.startsWith("INSERT INTO route_deviation_events")) {
      state.route_deviation_events.push({ ride_id: params[0], from_state: params[1], to_state: params[2], distance_from_route_m: params[3], lat: params[4], lng: params[5], gps_accuracy_m: params[6], note: null, created_at: new Date().toISOString() });
      return { rows: [] };
    }

    if (s.startsWith("SELECT distance_from_destination_km")) {
      const [rideId, limit] = params;
      const rows = state.route_deviation_events.filter((e) => e.ride_id === rideId).slice(-limit);
      return { rows: rows.map((e) => ({ d: e.distance_from_destination_km })) };
    }

    if (s.startsWith("SELECT id, status FROM safety_alerts") || s.startsWith("SELECT id, severity, status FROM safety_alerts")) {
      const [rideId, type] = params;
      const alert = state.safety_alerts.find((a) => a.ride_id === rideId && a.type === type && ["OPEN", "ACKNOWLEDGED", "INVESTIGATING"].includes(a.status));
      return { rows: alert ? [alert] : [] };
    }

    if (s.startsWith("UPDATE safety_alerts SET severity")) {
      const [severity, lat, lng, distM, distKm, speed, heading, accuracy, id] = params;
      const alert = state.safety_alerts.find((a) => a.id === id);
      Object.assign(alert, { severity, current_lat: lat, current_lng: lng, distance_from_route_m: distM, distance_from_destination_km: distKm });
      return { rows: [] };
    }

    if (s.startsWith("INSERT INTO safety_alerts")) {
      const [rideId, type, severity, lat, lng, distM, distKm, speed, heading, accuracy] = params;
      const id = state._nextAlertId++;
      state.safety_alerts.push({ id, ride_id: rideId, type, severity, status: "OPEN", current_lat: lat, current_lng: lng, distance_from_route_m: distM, distance_from_destination_km: distKm, created_at: new Date().toISOString() });
      return { rows: [{ id }] };
    }

    if (s.startsWith("UPDATE safety_alerts SET status = 'RESOLVED', resolved_at = now(), auto_resolved")) {
      const [note, id] = params;
      const alert = state.safety_alerts.find((a) => a.id === id);
      alert.status = "RESOLVED";
      alert.auto_resolved = true;
      return { rows: [] };
    }

    if (s.startsWith("INSERT INTO vehicle_current_state")) {
      const [vehicleId, lat, lng, speed, heading, accuracy, source, recordedAt, gpsHealth, rideId, driverId, routeState] = params;
      state.vehicle_current_state[vehicleId] = { vehicle_id: vehicleId, lat, lng, speed_kmh: speed, heading_deg: heading, accuracy_m: accuracy, source, recorded_at: recordedAt, gps_health: gpsHealth, current_ride_id: rideId, current_driver_id: driverId, route_state: routeState };
      return { rows: [] };
    }

    throw new Error(`fakeDb: unhandled query: ${s.slice(0, 60)}...`);
  }

  return { query, _state: state };
}

module.exports = { createFakeDb };
