import Constants from "expo-constants";

// Reads apiBaseUrl from app.json > expo.extra.apiBaseUrl.
// For local testing, override it there to your machine's LAN IP, e.g.
// "http://192.168.1.50:4000" — "localhost" won't reach your laptop from
// a physical phone, only from a simulator running on the same machine.
export const API_BASE_URL = Constants.expoConfig?.extra?.apiBaseUrl || "http://localhost:4000";
