import * as SecureStore from "expo-secure-store";

// Lets the QR scan-to-track flow work with zero internet connectivity.
//
// The problem: confirming a scan and starting live tracking is a server
// write (POST /api/rides/scan) — it has to be, since it flips the ride's
// status in the database. That part can never truly work offline. But a
// traveler landing with no data yet almost always already had connectivity
// earlier (when they booked, or any time TrackingScreen was open and polling
// before they got in the car) — at that point the app already knew which
// ride was "accepted" and who the driver was. We cache that here so it's
// still available the moment they scan, even with the phone in airplane
// mode or on a SIM with no roaming yet.
//
// Two independent things are cached:
//   1. The last known "active" ride (requested/accepted/in_progress) —
//      just enough to identify it and show driver/vehicle details.
//   2. A pending scan token — set when a scan attempt fails purely due to
//      connectivity (not a real server rejection), so it can be retried
//      automatically the moment a connection is available again.
//
// Deliberately reuses expo-secure-store (already a dependency, used for the
// auth token) rather than adding a new package like AsyncStorage — no new
// native module, no extra prebuild risk right before a build.

const ACTIVE_RIDE_KEY = "arrivo_cached_active_ride";
const PENDING_SCAN_KEY = "arrivo_pending_scan";

const CACHEABLE_STATUSES = ["requested", "accepted", "in_progress"];

export async function cacheActiveRide(ride) {
  if (!ride || !CACHEABLE_STATUSES.includes(ride.ride_status)) return;
  const summary = {
    id: ride.id,
    rideStatus: ride.ride_status,
    driverId: ride.driver_id || null,
    driverName: ride.driver_name || null,
    makeModel: ride.make_model || null,
    plateNumber: ride.plate_number || null,
    cachedAt: Date.now(),
  };
  try {
    await SecureStore.setItemAsync(ACTIVE_RIDE_KEY, JSON.stringify(summary));
  } catch {
    // Best-effort — if the device can't persist this, the offline fallback
    // just won't have a cache to fall back on later. Nothing else breaks.
  }
}

export async function getCachedActiveRide() {
  try {
    const raw = await SecureStore.getItemAsync(ACTIVE_RIDE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export async function clearCachedActiveRide() {
  try {
    await SecureStore.deleteItemAsync(ACTIVE_RIDE_KEY);
  } catch {
    // ignore
  }
}

// The pending scan also carries the ride id it was matched against offline,
// so TrackingScreen can flush it later without needing ScanScreen in memory.
export async function queuePendingScan(scanToken, rideId) {
  try {
    await SecureStore.setItemAsync(PENDING_SCAN_KEY, JSON.stringify({ scanToken, rideId, queuedAt: Date.now() }));
  } catch {
    // ignore
  }
}

export async function getPendingScan() {
  try {
    const raw = await SecureStore.getItemAsync(PENDING_SCAN_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export async function clearPendingScan() {
  try {
    await SecureStore.deleteItemAsync(PENDING_SCAN_KEY);
  } catch {
    // ignore
  }
}
