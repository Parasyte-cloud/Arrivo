import * as TaskManager from "expo-task-manager";
import * as SecureStore from "expo-secure-store";
import { updateLocation } from "../services/api";

// Name RiderArrivo's background location task registers under. Defined
// once at module load — TaskManager requires the task to exist before
// Location.startLocationUpdatesAsync ever references it, and this file is
// imported as a side effect (see hooks/useLocationReporting.js) rather
// than instantiated inside a component, since the task keeps firing even
// while the app is backgrounded or fully closed, when no component tree
// exists at all.
export const LOCATION_TASK_NAME = "arrivo-driver-background-location";

TaskManager.defineTask(LOCATION_TASK_NAME, async ({ data, error }) => {
  if (error) {
    console.warn("Background location task error:", error.message);
    return;
  }
  const location = data?.locations?.[0];
  if (!location) return;

  try {
    // Same SecureStore key AuthContext.js saves the driver's session
    // token under — a background task has no access to React context or
    // component state, so it reads the token directly rather than
    // receiving it as a prop/argument.
    const token = await SecureStore.getItemAsync("arrivo_driver_token");
    if (!token) return; // signed out — nothing to report against, and logout() stops this task anyway
    await updateLocation(token, location.coords.latitude, location.coords.longitude);
  } catch (err) {
    // Non-fatal — a single failed background report shouldn't crash
    // anything or stop future updates; it just retries next interval.
    console.warn("Background location report failed:", err.message);
  }
});
