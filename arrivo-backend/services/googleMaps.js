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

module.exports = { placesAutocomplete, placeDetails, getDistanceDuration };
