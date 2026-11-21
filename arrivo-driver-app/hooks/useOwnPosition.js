import { useEffect, useState } from "react";
import * as Location from "expo-location";

// The driver's own position, for the car on the trip map. It only watches while `enabled`
// (a trip is open), only if location is already allowed (useLocationReporting asks, this
// never shows a second prompt), and stops as soon as the trip card goes away.
// The background task still reports to the server; this is just for the screen.
export function useOwnPosition(enabled) {
  const [pos, setPos] = useState(null);
  useEffect(() => {
    if (!enabled) { setPos(null); return undefined; }
    let sub = null;
    let cancelled = false;
    (async () => {
      try {
        const perm = await Location.getForegroundPermissionsAsync();
        if (cancelled || perm.status !== "granted") return;
        sub = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.Balanced, timeInterval: 5000, distanceInterval: 15 },
          (loc) => {
            if (!cancelled && loc?.coords) setPos({ lat: loc.coords.latitude, lng: loc.coords.longitude });
          }
        );
        if (cancelled && sub) sub.remove();
      } catch (_) { /* no GPS, no car: the map still shows the route */ }
    })();
    return () => { cancelled = true; if (sub) sub.remove(); };
  }, [enabled]);
  return pos;
}
