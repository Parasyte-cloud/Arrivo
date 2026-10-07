// Against a REAL Postgres: an ArrivoExpress request must keep being offered
// to further drivers, in a widening radius, while the rider waits. Before
// this, the only batch of offers went out once at creation (3 km, 3 drivers)
// and a rider with no driver that close, or whose first drivers ignored the
// offer, waited until the request expired and was refunded.
//
//   DATABASE_URL=postgres://... node routes/instantRedispatch.integration.test.js
//   npm run test:integration

const assert = require("assert");
const http = require("http");
const jwt = require("jsonwebtoken");

process.env.JWT_SECRET = process.env.JWT_SECRET || "integration-test-secret";
process.env.ARRIVO_NOW_ENABLED = "true";

const express = require("express");
require("express-async-errors");
const { pool } = require("../db/db");
const { createWalletFundedRequest } = require("../services/instantWallet");
const { createOfferBatch, radiusForRequestAge } = require("../services/instantDispatch");

let passed = 0;
function test(name, fn) {
  return (async () => {
    try {
      await fn();
      console.log(`  ok  ${name}`);
      passed++;
    } catch (e) {
      console.log(`FAIL  ${name}`);
      console.log(`      ${e.stack || e.message}`);
      process.exitCode = 1;
    }
  })();
}

const app = express();
app.use(express.json());
app.use("/api/instant-rides", require("./instantRides"));
app.use((err, req, res, next) => res.status(500).json({ error: "server error", detail: err.message }));
const server = http.createServer(app);

async function getActive(token) {
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/api/instant-rides/rider/active`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

// One degree of latitude is about 111 km, so 0.009 is about 1 km.
const PICKUP = { lat: 6.5244, lng: 3.3792 };
const kmNorth = (km) => PICKUP.lat + km / 111;

async function makeUser(role, tag) {
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const r = await pool.query(
    `INSERT INTO users (name, email, password_hash, role, agreed_to_terms, wallet_balance_naira)
     VALUES ($1, $2, 'x', $3, true, $4) RETURNING *`,
    [`${tag} ${stamp}`, `${tag}-${stamp}@example.com`, role, role === "rider" ? 100000 : 0]
  );
  return r.rows[0];
}

async function makeDriver(distanceKm, tag) {
  const user = await makeUser("driver", tag);
  const vehicle = (await pool.query(
    `INSERT INTO vehicles (owner_user_id, make_model, plate_number, vehicle_type, seats)
     VALUES ($1, 'Test Car', $2, 'sedan', 4) RETURNING id`,
    [user.id, `T-${user.id}`]
  )).rows[0];
  const driver = (await pool.query(
    `INSERT INTO drivers (user_id, vehicle_id, is_verified, is_online, accepts_instant,
                          current_lat, current_lng, location_updated_at)
     VALUES ($1, $2, true, true, true, $3, $4, now()) RETURNING id`,
    [user.id, vehicle.id, kmNorth(distanceKm), PICKUP.lng]
  )).rows[0];
  return driver.id;
}

async function offeredDriverIds(requestId) {
  const r = await pool.query(
    `SELECT driver_id FROM instant_ride_offers WHERE request_id = $1`,
    [requestId]
  );
  return r.rows.map((x) => x.driver_id);
}

(async () => {
  await new Promise((resolve) => server.listen(0, resolve));

  await test("the search radius widens with the age of the request, capped at 25 km", () => {
    assert.strictEqual(radiusForRequestAge(0, 3), 3);
    assert.strictEqual(radiusForRequestAge(39, 3), 3);
    assert.strictEqual(radiusForRequestAge(40, 3), 6);
    assert.strictEqual(radiusForRequestAge(80, 3), 12);
    assert.strictEqual(radiusForRequestAge(120, 3), 24);
    assert.strictEqual(radiusForRequestAge(500, 3), 25);
    assert.strictEqual(radiusForRequestAge(undefined, 3), 3);
  });

  await test("rider polling re-offers the trip to the next drivers as the radius grows", async () => {
    const rider = await makeUser("rider", "rd-rider");
    const token = jwt.sign({ id: rider.id, email: rider.email, role: "rider" }, process.env.JWT_SECRET);

    const near = await makeDriver(1, "rd-near");     // inside the first 3 km
    const mid = await makeDriver(5, "rd-mid");       // needs the 6 km step
    const far = await makeDriver(10, "rd-far");      // needs the 12 km step
    await makeDriver(40, "rd-outside");              // beyond any radius we reach

    const funded = await createWalletFundedRequest({
      riderId: rider.id,
      trip: {
        pickupAddress: "Ikeja", pickupLat: PICKUP.lat, pickupLng: PICKUP.lng,
        destinationAddress: "Lekki", destinationLat: 6.45, destinationLng: 3.47,
        vehicleType: "sedan", tier: "economy", minSeats: 1,
      },
      quote: { fareNaira: 5000, distanceKm: 20, durationMin: 40 },
    });
    const requestId = funded.request.id;

    // First batch, exactly as POST /api/instant-rides does it.
    const first = await createOfferBatch(requestId);
    assert.strictEqual(first.status, "offering");
    assert.deepStrictEqual(await offeredDriverIds(requestId), [near]);

    // Polling while the first offer is still live changes nothing.
    let poll = await getActive(token);
    assert.strictEqual(poll.status, 200);
    assert.deepStrictEqual(await offeredDriverIds(requestId), [near]);

    // The first driver ignores it: the offer lapses, 50 seconds in.
    await pool.query(`UPDATE instant_ride_offers SET expires_at = now() - interval '1 second' WHERE request_id = $1`, [requestId]);
    await pool.query(`UPDATE instant_ride_requests SET created_at = now() - interval '50 seconds' WHERE id = $1`, [requestId]);

    poll = await getActive(token);
    assert.strictEqual(poll.status, 200);
    assert.strictEqual(poll.body.request.status, "offering");
    const afterSecond = (await offeredDriverIds(requestId)).sort((a, b) => a - b);
    assert.deepStrictEqual(afterSecond, [near, mid].sort((a, b) => a - b), "mid-range driver is offered, near driver is not offered twice");

    // The second driver lapses too, 90 seconds in: the 12 km step reaches the far driver.
    await pool.query(`UPDATE instant_ride_offers SET expires_at = now() - interval '1 second' WHERE request_id = $1 AND status = 'offered'`, [requestId]);
    await pool.query(`UPDATE instant_ride_requests SET created_at = now() - interval '90 seconds' WHERE id = $1`, [requestId]);

    poll = await getActive(token);
    assert.strictEqual(poll.body.request.status, "offering");
    const afterThird = (await offeredDriverIds(requestId)).sort((a, b) => a - b);
    assert.deepStrictEqual(afterThird, [near, mid, far].sort((a, b) => a - b));
  });

  await test("a rider with nobody online keeps searching without an error", async () => {
    await pool.query(`UPDATE drivers SET is_online = false`);
    const rider = await makeUser("rider", "rd-alone");
    const token = jwt.sign({ id: rider.id, email: rider.email, role: "rider" }, process.env.JWT_SECRET);
    await createWalletFundedRequest({
      riderId: rider.id,
      trip: {
        pickupAddress: "Ikeja", pickupLat: PICKUP.lat, pickupLng: PICKUP.lng,
        destinationAddress: "Lekki", destinationLat: 6.45, destinationLng: 3.47,
        vehicleType: "sedan", tier: "economy", minSeats: 1,
      },
      quote: { fareNaira: 5000, distanceKm: 20, durationMin: 40 },
    });
    const poll = await getActive(token);
    assert.strictEqual(poll.status, 200);
    assert.strictEqual(poll.body.request.status, "searching");
  });

  console.log(`\n${passed} passed`);
  server.close();
  await pool.end();
})();
