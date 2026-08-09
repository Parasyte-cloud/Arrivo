const { RoutingProvider, RoutingProviderError } = require("./RoutingProvider");

// Mapbox Directions API adapter. Talks to Mapbox's actual response
// shape in this one file only — nothing else in the app should ever
// import Mapbox directly or know its response format.
//
// Requires MAPBOX_ACCESS_TOKEN as an environment variable. The token
// stays server-side always — this class is only ever called from the
// backend, never shipped to a client, matching the review's security
// requirement that provider secrets never reach the browser.
class MapboxRoutingProvider extends RoutingProvider {
  constructor({ accessToken = process.env.MAPBOX_ACCESS_TOKEN, fetchImpl = fetch } = {}) {
    super();
    if (!accessToken) {
      throw new Error("MapboxRoutingProvider requires an access token (set MAPBOX_ACCESS_TOKEN)");
    }
    this.accessToken = accessToken;
    this.fetch = fetchImpl;
  }

  async getRoute(pickup, destination) {
    const url =
      `https://api.mapbox.com/directions/v5/mapbox/driving/` +
      `${pickup.lng},${pickup.lat};${destination.lng},${destination.lat}` +
      `?geometries=geojson&overview=full&access_token=${this.accessToken}`;

    let res;
    try {
      // This call sits directly in the PATCH /api/drivers/location hot
      // path (via processTelemetry -> evaluateAndPossiblyReroute) — every
      // driver's location update would hang waiting on Mapbox without a
      // hard cap. 8s is generous for a directions lookup but still bounds
      // the worst case instead of leaving it fully open-ended.
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      try {
        res = await this.fetch(url, { signal: controller.signal });
      } finally {
        clearTimeout(timeout);
      }
    } catch (e) {
      // Network failure OR timeout — both explicitly retryable, per the
      // review's requirement that a provider outage never silently break
      // a ride.
      throw new RoutingProviderError(`Mapbox request failed: ${e.message}`, { retryable: true });
    }

    if (!res.ok) {
      const retryable = res.status >= 500 || res.status === 429;
      throw new RoutingProviderError(`Mapbox returned ${res.status}`, { retryable });
    }

    const data = await res.json();
    const route = data.routes && data.routes[0];
    if (!route) {
      throw new RoutingProviderError("Mapbox returned no route between these points", { retryable: false });
    }

    return {
      geometry: route.geometry.coordinates.map(([lng, lat]) => ({ lat, lng })),
      distanceKm: route.distance / 1000,
      durationMin: route.duration / 60,
      providerRouteId: null, // Mapbox Directions API doesn't issue a persistent route ID
    };
  }
}

module.exports = { MapboxRoutingProvider };
