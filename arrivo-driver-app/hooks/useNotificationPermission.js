import { useEffect } from "react";
import * as Notifications from "expo-notifications";

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
export function useNotificationPermission(token) {
  useEffect(() => {
    if (!token) return;

    (async () => {
      try {
        const { status: existingStatus } = await Notifications.getPermissionsAsync();
        if (existingStatus !== "granted") {
          await Notifications.requestPermissionsAsync();
        }
      } catch (e) {
        // Non-critical — see comment above.
      }
    })();
  }, [token]);
}
