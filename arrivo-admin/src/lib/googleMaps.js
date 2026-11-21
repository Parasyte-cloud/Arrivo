// Loads the Google Maps JavaScript API once, on demand. The key is a browser key
// (VITE_GOOGLE_MAPS_API_KEY) restricted by HTTP referrer to the Ops Console domains,
// with the Maps JavaScript API and Routes API enabled. Without a key the
// Trip Tracker falls back to a basic OpenStreetMap map, so nothing breaks.
export const googleMapsKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || "";

let loading = null;

export function loadGoogleMaps(key = googleMapsKey) {
  if (!key) return Promise.reject(new Error("No Google Maps key configured."));
  if (window.google?.maps?.Map) return Promise.resolve(window.google.maps);
  if (loading) return loading;

  loading = new Promise((resolve, reject) => {
    // Google calls this when the key is rejected (wrong referrer, API not enabled, billing off).
    window.gm_authFailure = () => {
      window.dispatchEvent(new CustomEvent("ra-gm-auth-failure"));
      reject(new Error("Google Maps rejected the API key. Check the referrer restriction and that the Maps JavaScript API is enabled."));
    };
    window.__raGmReady = () => resolve(window.google.maps);
    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&callback=__raGmReady`;
    script.async = true;
    script.onerror = () => reject(new Error("Could not load Google Maps (blocked or offline)."));
    document.head.appendChild(script);
  });
  loading.catch(() => { loading = null; });
  return loading;
}
