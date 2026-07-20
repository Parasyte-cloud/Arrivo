// Sends push notifications via Expo's push service. This works for any
// Expo-managed app without separate Firebase/APNs credentials — Expo's
// service proxies delivery to both platforms from a single HTTP call.
// See docs.expo.dev/push-notifications/sending-notifications.
//
// Uses the same fire-and-forget-with-timeout pattern as services/email.js:
// a failed/slow push should never block or fail the API request that
// triggered it (e.g. a driver accepting a ride shouldn't 500 just because
// a push notification couldn't be delivered).

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

async function sendPushNotification(pushToken, title, body, data = {}) {
  if (!pushToken) return { skipped: true };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(EXPO_PUSH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ to: pushToken, title, body, data, sound: "default" }),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.error(`[push] Expo push API returned ${res.status} for token ${pushToken}`);
      return { ok: false };
    }
    const json = await res.json().catch(() => null);
    if (json?.data?.status === "error") {
      console.error(`[push] Expo push API rejected the message:`, json.data.message);
      return { ok: false };
    }
    return { ok: true };
  } catch (e) {
    console.error("[push] Failed to send notification:", e.name === "AbortError" ? "timed out after 10s" : e.message);
    return { ok: false };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { sendPushNotification };
