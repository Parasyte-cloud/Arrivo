import { useEffect } from "react";
import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
import Constants from "expo-constants";
import { registerPushToken } from "../services/api";

// This app never had any notification-permission flow before — ride
// requests are handled by polling, not push (see DashboardScreen.js). But
// Stream's incoming-call notifications (the CallKit/ringing UI, see
// utils/setPushConfig.js) need Android's POST_NOTIFICATIONS runtime
// permission (API 33+) granted to actually show, so this requests it once
// per login. Failing/declining is non-fatal — a call can still ring via
// CallKit's foreground path, it just may not show a system notification
// alongside it on newer Android versions.
//
// Deliberately does NOT create/touch the "incoming_call_channel" Android
// notification channel here — Stream's own SDK creates and owns that
// channel (see the `incomingChannel` config in utils/setPushConfig.js).
// Android notification channel settings are locked in on first creation,
// so a second, differently-configured creation call here could freeze in
// the wrong settings if it happened to run first.
//
// It also registers this phone's push token with the backend. Without one the
// backend had no way to tell a driver a ride was booked or assigned to them,
// so rides only got picked up by drivers who happened to have the app open.
export function useNotificationPermission(token) {
  useEffect(() => {
    if (!token) return;

    (async () => {
      try {
        const { status: existingStatus } = await Notifications.getPermissionsAsync();
        let finalStatus = existingStatus;
        if (existingStatus !== "granted") {
          finalStatus = (await Notifications.requestPermissionsAsync()).status;
        }
        if (finalStatus !== "granted") return;

        // Ride alerts go on the "default" channel, set to high so they pop up
        // over other apps. Not the call channel, which Stream owns.
        if (Platform.OS === "android") {
          await Notifications.setNotificationChannelAsync("default", {
            name: "Rides",
            importance: Notifications.AndroidImportance.HIGH,
          });
        }

        // Real phones only; emulators throw here and the catch swallows it.
        const projectId = Constants.expoConfig?.extra?.eas?.projectId;
        const { data: pushToken } = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
        await registerPushToken(token, pushToken);
      } catch (e) {
        // Non-critical — see comment above. Polling still finds rides while the app is open.
      }
    })();
  }, [token]);
}
