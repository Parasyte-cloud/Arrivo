// Server-side-only Google Maps calls — Places Autocomplete, Place Details,
// and Distance Matrix. This key (GOOGLE_MAPS_SERVER_KEY) is never sent to
// either app; the apps call our own /api/places/* routes instead, which
// proxy through here. That's deliberate, not just convenience: it keeps
// the key off every device, lets us enforce our own auth on who can use
// it, and means the distance/duration behind every fare quote is computed
// from a source the client never touches — the same "never trust the
// client with money-relevant numbers" principle as payment verification.
//
// This is a DIFFERENT key from the one already live on ridearrivo.com's
// book.html — that one is a browser key restricted by HTTP referrer
// (only works when called from a page loaded on ridearrivo.com) and only
// has the Maps JavaScript API + Places API enabled. This one needs Places
// API + Distance Matrix API enabled, and should be restricted by server
// IP (or left unrestricted if your host's IP isn't static) rather than
// by referrer, since there's no browser involved on this side.
const axios = require("axios");

const PLACES_BASE = "https://maps.googleapis.com/maps/api/place";
const DISTANCE_MATRIX_URL = "https://maps.googleapis.com/maps/api/distancematrix/json";
const GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json";

function requireKey() {
  const key = process.env.GOOGLE_MAPS_SERVER_KEY;
  if (!key || key.includes("replace_me")) {
    throw new Error("GOOGLE_MAPS_SERVER_KEY is not configured on the server");
  }
  return key;
}

// Restricted to Nigeria (components=country:ng) since RideArrivo only
// operates in and around Lagos — cuts noise and keeps autocomplete
// billing usage down. sessionToken should be a random string the client
// generates once per address-entry session (Google bills autocomplete +
// the matching details call together as a single session when a
// consistent token is passed through both).
async function placesAutocomplete(input, sessionToken) {
  const key = requireKey();
  const response = await axios.get(`${PLACES_BASE}/autocomplete/json`, {
    params: {
      input,
      key,
      components: "country:ng",
      sessiontoken: sessionToken || undefined,
    },
  });
  if (response.data.status !== "OK" && response.data.status !== "ZERO_RESULTS") {
    throw new Error(`Places Autocomplete failed: ${response.data.status} ${response.data.error_message || ""}`.trim());
  }
  return (response.data.predictions || []).map((p) => ({
    placeId: p.place_id,
    description: p.description,
  }));
}

async function placeDetails(placeId, sessionToken) {
  const key = requireKey();
  const response = await axios.get(`${PLACES_BASE}/details/json`, {
    params: {
      place_id: placeId,
      key,
      fields: "geometry,formatted_address",
      sessiontoken: sessionToken || undefined,
    },
  });
  if (response.data.status !== "OK") {
    throw new Error(`Place Details failed: ${response.data.status} ${response.data.error_message || ""}`.trim());
  }
  const result = response.data.result;
  return {
    address: result.formatted_address,
    lat: result.geometry.location.lat,
    lng: result.geometry.location.lng,
  };
}

// departure_time=now + traffic_model=best_guess so the duration reflects
// actual Lagos traffic conditions rather than free-flow driving time —
// meaningfully different in a city where a 10km trip can take anywhere
// from 15 minutes to over an hour depending on time of day.
async function getDistanceDuration(originLat, originLng, destLat, destLng) {
  const key = requireKey();
  const response = await axios.get(DISTANCE_MATRIX_URL, {
    params: {
      origins: `${originLat},${originLng}`,
      destinations: `${destLat},${destLng}`,
      key,
      departure_time: "now",
      traffic_model: "best_guess",
    },
  });
  if (response.data.status !== "OK") {
    throw new Error(`Distance Matrix failed: ${response.data.status} ${response.data.error_message || ""}`.trim());
  }
  const element = response.data.rows?.[0]?.elements?.[0];
  if (!element || element.status !== "OK") {
    throw new Error(`Distance Matrix couldn't find a route (${element?.status || "no result"})`);
  }
  return {
    distanceKm: element.distance.value / 1000,
    durationMin: (element.duration_in_traffic || element.duration).value / 60,
  };
}

// The reverse of placeDetails above: turns a device's raw GPS coordinate
// into a human-readable address, for the rider app's "use my current
// location" button on the pickup field (RouteScreen/ChauffeurScreen).
// Uses the plain Geocoding API, not Places — different endpoint, but the
// same server-side key (GOOGLE_MAPS_SERVER_KEY) works as long as the
// Geocoding API is also enabled for it in Google Cloud Console.
async function reverseGeocode(lat, lng) {
  const key = requireKey();
  const response = await axios.get(GEOCODE_URL, {
    params: { latlng: `${lat},${lng}`, key },
  });
  if (response.data.status !== "OK") {
    throw new Error(`Reverse geocode failed: ${response.data.status} ${response.data.error_message || ""}`.trim());
  }
  const result = response.data.results?.[0];
  if (!result) throw new Error("Reverse geocode returned no results");
  return { address: result.formatted_address, lat, lng };
}


// ── Road route for the live map ─────────────────────────────────────────
// The map in both apps draws the road the car will take, like ArrivoExpress,
// not a straight line. The browser never sees the server key, so the apps ask
// us. Routes API first, the older Directions API as the backup, and null when
// neither answers so the app falls back to a plain line.
const ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes";
const DIRECTIONS_URL = "https://maps.googleapis.com/maps/api/directions/json";
const ROUTE_CACHE_MS = 5 * 60 * 1000;
const routeCache = new Map();

// Google's encoded polyline format: each number is a delta from the last point.
function decodePolyline(encoded) {
  const out = [];
  let i = 0, lat = 0, lng = 0;
  const str = String(encoded || "");
  while (i < str.length) {
    for (const axis of [0, 1]) {
      let shift = 0, result = 0, b;
      do {
        if (i >= str.length) return out;
        b = str.charCodeAt(i++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === 0) lat += delta; else lng += delta;
    }
    out.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return out;
}

// Keeps the reply small: at most `max` points, always including both ends.
function thinPath(path, max = 250) {
  if (path.length <= max) return path;
  const step = (path.length - 1) / (max - 1);
  const out = [];
  for (let k = 0; k < max; k++) out.push(path[Math.round(k * step)]);
  return out;
}

async function computeRoute(from, to) {
  const key = requireKey();
  // About 11 m grid, so a car creeping along does not defeat the cache.
  const r = (n) => Number(n).toFixed(4);
  const cacheKey = `${r(from.lat)},${r(from.lng)}>${r(to.lat)},${r(to.lng)}`;
  const hit = routeCache.get(cacheKey);
  if (hit && Date.now() - hit.at < ROUTE_CACHE_MS) return hit.value;

  let value = null;
  try {
    const res = await axios.post(
      ROUTES_URL,
      {
        origin: { location: { latLng: { latitude: from.lat, longitude: from.lng } } },
        destination: { location: { latLng: { latitude: to.lat, longitude: to.lng } } },
        travelMode: "DRIVE",
        routingPreference: "TRAFFIC_AWARE",
      },
      { headers: { "X-Goog-Api-Key": key, "X-Goog-FieldMask": "routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline" }, timeout: 8000 }
    );
    const route = res.data?.routes?.[0];
    if (route?.polyline?.encodedPolyline) {
      value = {
        path: thinPath(decodePolyline(route.polyline.encodedPolyline)),
        distanceMeters: route.distanceMeters ?? null,
        durationSeconds: parseInt(String(route.duration || "").replace("s", ""), 10) || null,
      };
    }
  } catch (err) {
    console.error("Routes API failed, trying Directions:", err.response?.data?.error?.message || err.message);
  }
  if (!value) {
    try {
      const res = await axios.get(DIRECTIONS_URL, {
        params: { origin: `${from.lat},${from.lng}`, destination: `${to.lat},${to.lng}`, departure_time: "now", key },
        timeout: 8000,
      });
      const route = res.data?.routes?.[0];
      const leg = route?.legs?.[0];
      if (res.data?.status === "OK" && route?.overview_polyline?.points) {
        value = {
          path: thinPath(decodePolyline(route.overview_polyline.points)),
          distanceMeters: leg?.distance?.value ?? null,
          durationSeconds: (leg?.duration_in_traffic || leg?.duration)?.value ?? null,
        };
      }
    } catch (err) {
      console.error("Directions API failed:", err.message);
    }
  }
  if (value) {
    routeCache.set(cacheKey, { at: Date.now(), value });
    if (routeCache.size > 500) routeCache.delete(routeCache.keys().next().value);
  }
  return value;
}

module.exports = { placesAutocomplete, placeDetails, getDistanceDuration, reverseGeocode, computeRoute, decodePolyline, thinPath };
