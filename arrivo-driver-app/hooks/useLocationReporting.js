import { useEffect, useRef } from "react";
import * as Location from "expo-location";
import { updateLocation } from "../services/api";

const REPORT_INTERVAL_MS = 20000; // how often the phone posts its GPS position while online

// Periodically reads the phone's GPS and posts it to PATCH /api/drivers/location
// whenever `isOnline` is true. This is what the admin dashboard and rider
// tracking screen ultimately read from — without this, a driver's position
// is only ever whatever they last reported (or nothing at all).
export function useLocationReporting(token, isOnline) {
  const intervalRef = useRef(null);

  useEffect(() => {
    let cancelled = false;

    async function reportOnce() {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== "granted") {
          console.warn("Location permission not granted — driver position won't be shared with riders.");
          return;
        }
        const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        if (cancelled) return;
        await updateLocation(token, position.coords.latitude, position.coords.longitude);
      } catch (err) {
        // Non-fatal — a single failed location ping shouldn't crash the app
        // or interrupt the driver's shift. It'll just retry next interval.
        console.warn("Location report failed:", err.message);
      }
    }

    if (isOnline && token) {
      reportOnce(); // send one immediately on going online, don't wait for the first interval
      intervalRef.current = setInterval(reportOnce, REPORT_INTERVAL_MS);
    }

    return () => {
      cancelled = true;
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [isOnline, token]);
}
