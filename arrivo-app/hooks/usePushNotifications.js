import { useEffect } from "react";
import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
import Constants from "expo-constants";
import { registerPushToken } from "../services/api";

// Registers this device for push notifications and sends the resulting
// Expo push token to the backend, so it can notify the rider about trip
// status changes (driver accepted, trip started/completed, rate your
// driver). Runs once per login — if the rider denies permission, we just
// skip silently rather than nagging them, since push is a convenience,
// not core to using the app (the tracking screen still polls regardless).
export function usePushNotifications(token) {
  useEffect(() => {
    if (!token) return;

    (async () => {
      try {
        if (Platform.OS === "android") {
          await Notifications.setNotificationChannelAsync("default", {
            name: "default",
            importance: Notifications.AndroidImportance.DEFAULT,
          });
        }

        const { status: existingStatus } = await Notifications.getPermissionsAsync();
        let finalStatus = existingStatus;
        if (existingStatus !== "granted") {
          const { status } = await Notifications.requestPermissionsAsync();
          finalStatus = status;
        }
        if (finalStatus !== "granted") return;

        // Physical-device-only in practice (simulators/emulators can't
        // receive real push tokens) — getExpoPushTokenAsync will throw on
        // those, which the outer catch below swallows harmlessly.
        const projectId = Constants.expoConfig?.extra?.eas?.projectId;
        const { data: pushToken } = await Notifications.getExpoPushTokenAsync(
          projectId ? { projectId } : undefined
        );
        await registerPushToken(token, pushToken);
      } catch (e) {
        // Non-critical — the app works fine without push, this just means
        // trip updates won't show up as notifications for this session.
      }
    })();
  }, [token]);
}
