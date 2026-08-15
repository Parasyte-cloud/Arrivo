// Abstract interface every routing provider implements. The rest of the
// application depends on this shape, never on a specific provider's SDK
// or response format — that's what lets RideArrivo swap Mapbox for
// Google Roads, self-hosted OSRM, or anything else later by writing one
// new adapter file, not by touching the deviation engine, the route
// persistence logic, or any API route.
//
// getRoute() must return, or throw a RoutingProviderError:
//   {
//     geometry: [{lat, lng}, ...],   // ordered points along the route
//     distanceKm: number,
//     durationMin: number,
//     providerRouteId: string | null, // provider's own ID for this route, if it has one
//   }

class RoutingProviderError extends Error {
  constructor(message, { retryable = false } = {}) {
    super(message);
    this.name = "RoutingProviderError";
    this.retryable = retryable;
  }
}

class RoutingProvider {
  async getRoute(_pickup, _destination) {
    throw new Error("getRoute() must be implemented by a RoutingProvider subclass");
  }
}

module.exports = { RoutingProvider, RoutingProviderError };
