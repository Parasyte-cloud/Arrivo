const { RoutingProvider, RoutingProviderError } = require("./RoutingProvider");

// Deterministic in-memory provider for tests and local development
// without API credentials. Returns a straight line between the two
// points as the "route" — fine for exercising the surrounding logic,
// not meant to represent real road geometry.
class FakeRoutingProvider extends RoutingProvider {
  constructor({ shouldFail = false, retryable = false } = {}) {
    super();
    this.shouldFail = shouldFail;
    this.retryable = retryable;
  }

  async getRoute(pickup, destination) {
    if (this.shouldFail) {
      throw new RoutingProviderError("Simulated routing provider failure", { retryable: this.retryable });
    }
    const distanceKm = require("../routeDeviation").haversineMeters(pickup, destination) / 1000;
    return {
      geometry: [pickup, destination],
      distanceKm,
      durationMin: (distanceKm / 30) * 60, // assume 30km/h average, fine for a fake
      providerRouteId: null,
    };
  }
}

module.exports = { FakeRoutingProvider };
