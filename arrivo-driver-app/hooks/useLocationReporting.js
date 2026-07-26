import { useEffect } from "react";
import * as Location from "expo-location";
import "../tasks/backgroundLocationTask"; // registers the TaskManager task as a side effect — must run once before start() below
import { LOCATION_TASK_NAME } from "../tasks/backgroundLocationTask";

const REPORT_INTERVAL_MS = 20000; // how often a position update is delivered, foreground or background

// Starts/stops a background-capable location subscription whenever the
// driver toggles online. This replaces the old setInterval + foreground-
// only getCurrentPositionAsync approach, which stopped reporting the
// instant a driver backgrounded the app, locked their phone, or switched
// to another app mid-shift — the three most realistic things a driver
// actually does while waiting for or running a trip. Location.startLocationUpdatesAsync
// keeps delivering updates to the task in tasks/backgroundLocationTask.js
// regardless of whether the app is in the foreground, as long as
// background location permission was granted.
// onError (optional): called with a user-facing message string whenever
// starting/stopping location reporting fails or permission is denied.
// Previously start()/stop() were invoked as bare async calls with no catch
// at the call site — permission-denied only ever got a console.warn (never
// shown to the driver), and any other thrown error (a well-known source of
// native-side throws when Info.plist/AndroidManifest background-location
// config is off) became a silent unhandled promise rejection. A driver
// could be toggled "online" in the UI while reporting no location at all,
// with nothing telling them why.
export function useLocationReporting(token, isOnline, onError) {
  useEffect(() => {
    let cancelled = false;

    async function start() {
      const fg = await Location.requestForegroundPermissionsAsync();
      if (cancelled || fg.status !== "granted") {
        if (fg.status !== "granted") {
          console.warn("Location permission not granted — driver position won't be shared with riders.");
          onError?.("Location permission is off — riders won't be able to see your position. Enable it in Settings to go online.");
        }
        return;
      }

      // Background permission is a separate, second prompt on both
      // platforms (and on Android 11+, often a second trip to Settings).
      // If it's denied we still fall back to foreground-only reporting
      // via the same API — better than reporting nothing at all.
      const bg = await Location.requestBackgroundPermissionsAsync();
      if (cancelled) return;

      const alreadyStarted = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME).catch(() => false);
      if (alreadyStarted) return;

      await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, {
        accuracy: Location.Accuracy.Balanced,
        timeInterval: REPORT_INTERVAL_MS,
        distanceInterval: 0,
        showsBackgroundLocationIndicator: true, // iOS: shows the blue status-bar pill — never silently tracking
        foregroundService: bg.status === "granted" ? {
          notificationTitle: "RideArrivo Driver is online",
          notificationBody: "Sharing your location so riders can see you en route.",
        } : undefined,
      });
    }

    async function stop() {
      const alreadyStarted = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME).catch(() => false);
      if (alreadyStarted) await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
    }

    if (isOnline && token) {
      start().catch((e) => {
        console.error("Failed to start location reporting:", e.message);
        onError?.("Couldn't start sharing your location — try toggling online again, or check location settings.");
      });
    } else {
      stop().catch((e) => console.error("Failed to stop location reporting:", e.message));
    }

    // Deliberately not stopping on unmount/dependency-change cleanup —
    // only the isOnline===false branch above does that. The entire point
    // of a background task is that it keeps running after the component
    // (or even the whole JS app) goes away; stopping it on unmount would
    // silently kill location sharing the moment the driver leaves this
    // screen mid-trip, defeating the purpose of this change.
    return () => { cancelled = true; };
  }, [isOnline, token]);
}
