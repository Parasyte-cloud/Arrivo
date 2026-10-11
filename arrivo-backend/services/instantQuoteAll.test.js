// Tests for the all-tier quote. The Google routing call is stubbed, so this
// needs no network and no database:  node services/instantQuoteAll.test.js

const assert = require("assert");
const path = require("path");

let routeCalls = 0;
const mapsPath = require.resolve("./googleMaps");
require.cache[mapsPath] = {
  id: mapsPath,
  filename: mapsPath,
  loaded: true,
  exports: {
    getDistanceDuration: async () => {
      routeCalls++;
      return { distanceKm: 12, durationMin: 30 };
    },
  },
};

// No database in unit tests: no published prices, so the code defaults apply.
const bookPath = require.resolve("./instantPriceBook");
require.cache[bookPath] = {
  id: bookPath,
  filename: bookPath,
  loaded: true,
  exports: { getActivePricing: async () => null },
};

const { quoteAllTiers, quoteInstantRide, InstantQuoteError } = require("./instantQuote");

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
    passed++;
  } catch (e) {
    console.error(`  FAIL  ${name}`);
    console.error(e);
    process.exitCode = 1;
  }
}

const trip = {
  pickupAddress: "Lekki Phase 1, Lagos",
  pickupLat: 6.4474,
  pickupLng: 3.4723,
  destinationAddress: "Ikeja, Lagos",
  destinationLat: 6.6018,
  destinationLng: 3.3515,
};

(async () => {
  await test("prices every tier from a single route lookup", async () => {
    routeCalls = 0;
    const { quotes, route } = await quoteAllTiers(trip);
    assert.strictEqual(routeCalls, 1);
    assert.deepStrictEqual(quotes.map((q) => q.tier), ["economy", "comfort", "xl", "premium"]);
    assert.deepStrictEqual(route, { distanceKm: 12, durationMin: 30 });
  });

  await test("fares climb with the tier", async () => {
    const { quotes } = await quoteAllTiers(trip);
    for (let i = 1; i < quotes.length; i++) {
      assert.ok(quotes[i].fareNaira > quotes[i - 1].fareNaira, `${quotes[i].tier} should cost more than ${quotes[i - 1].tier}`);
    }
  });

  await test("each entry matches what the single-tier quote would charge", async () => {
    const { quotes } = await quoteAllTiers(trip);
    for (const q of quotes) {
      const single = await quoteInstantRide({ ...trip, tier: q.tier });
      assert.strictEqual(q.fareNaira, single.fareNaira, q.tier);
      assert.deepStrictEqual(q.breakdown, single.breakdown, q.tier);
    }
  });

  await test("every entry carries what booking needs", async () => {
    const { quotes } = await quoteAllTiers(trip);
    for (const q of quotes) {
      assert.strictEqual(q.currency, "NGN");
      assert.strictEqual(q.pickupLat, trip.pickupLat);
      assert.ok(Number.isInteger(q.fareNaira) && q.fareNaira > 0);
    }
  });

  await test("a tier sent by the client is ignored, not trusted", async () => {
    const { quotes } = await quoteAllTiers({ ...trip, tier: "nonsense" });
    assert.strictEqual(quotes.length, 4);
  });

  await test("bad coordinates are rejected", async () => {
    await assert.rejects(() => quoteAllTiers({ ...trip, pickupLat: 999 }), InstantQuoteError);
    await assert.rejects(() => quoteAllTiers({ ...trip, destinationAddress: "" }), InstantQuoteError);
  });

  console.log(`${passed} passed`);
})();
