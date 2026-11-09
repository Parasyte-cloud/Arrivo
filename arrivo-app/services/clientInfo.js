import { Platform } from "react-native";
import Constants from "expo-constants";

// Tells the backend which app and version is calling, so it can answer 426
// when the build is below the minimum (arrivo-backend/services/appVersion.js).
// Sent on every API request. The version is the one in app.json, which EAS
// bumps per store build.
const APP_VERSION = String(Constants.expoConfig?.version || "").slice(0, 32);

export function clientHeaders() {
  const headers = { "X-App-Name": "rider", "X-App-Platform": Platform.OS === "ios" ? "ios" : "android" };
  if (APP_VERSION) headers["X-App-Version"] = APP_VERSION;
  return headers;
}

export function appVersion() {
  return APP_VERSION;
}
