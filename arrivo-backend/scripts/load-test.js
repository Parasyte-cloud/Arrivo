// Load-test harness — run this yourself against a real staging
// deployment. This assistant has no live server to run it against, so
// no results are reported anywhere; running this and getting real
// numbers is what turns "harness exists" into actual evidence.
//
// Usage:
//   TARGET_URL="https://your-staging.onrender.com" \
//   AUTH_TOKEN="a real driver JWT" \
//   VEHICLE_COUNT=100 INTERVAL_SECONDS=20 DURATION_SECONDS=120 \
//   node scripts/load-test.js

const TARGET_URL = process.env.TARGET_URL;
const AUTH_TOKEN = process.env.AUTH_TOKEN;
const VEHICLE_COUNT = parseInt(process.env.VEHICLE_COUNT || "100", 10);
const INTERVAL_SECONDS = parseInt(process.env.INTERVAL_SECONDS || "20", 10);
const DURATION_SECONDS = parseInt(process.env.DURATION_SECONDS || "120", 10);

if (!TARGET_URL || !AUTH_TOKEN) {
  console.error("Set TARGET_URL and AUTH_TOKEN environment variables first.");
  process.exit(1);
}

// Simulated vehicles start clustered around Lagos and take small,
// realistic steps each tick — not teleporting, so this naturally avoids
// tripping the impossible-jump validator unless VEHICLE_COUNT /
// INTERVAL_SECONDS is set unrealistically.
const vehicles = Array.from({ length: VEHICLE_COUNT }, (_, i) => ({
  id: i,
  lat: 6.5244 + (Math.random() - 0.5) * 0.05,
  lng: 3.3792 + (Math.random() - 0.5) * 0.05,
  heading: Math.random() * 360,
}));

function step(vehicle) {
  const speedKmh = 20 + Math.random() * 30;
  const distanceKm = (speedKmh * INTERVAL_SECONDS) / 3600;
  const headingRad = (vehicle.heading * Math.PI) / 180;
  vehicle.lat += (distanceKm / 111.32) * Math.cos(headingRad);
  vehicle.lng += (distanceKm / (111.32 * Math.cos((vehicle.lat * Math.PI) / 180))) * Math.sin(headingRad);
  vehicle.heading += (Math.random() - 0.5) * 20; // gentle drift, not sharp turns every tick
  return { lat: vehicle.lat, lng: vehicle.lng, accuracy: 10 + Math.random() * 20, speed: speedKmh, heading: vehicle.heading };
}

const latencies = [];
let succeeded = 0;
let failed = 0;

async function sendOne(vehicle) {
  const body = step(vehicle);
  const start = Date.now();
  try {
    const res = await fetch(`${TARGET_URL}/api/drivers/location`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${AUTH_TOKEN}` },
      body: JSON.stringify(body),
    });
    latencies.push(Date.now() - start);
    if (res.ok) succeeded++; else failed++;
  } catch (e) {
    failed++;
  }
}

function percentile(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.floor((p / 100) * sorted.length);
  return sorted[Math.min(idx, sorted.length - 1)];
}

async function run() {
  console.log(`Load test: ${VEHICLE_COUNT} vehicles, one request every ${INTERVAL_SECONDS}s each, for ${DURATION_SECONDS}s total.`);
  console.log(`Target: ${TARGET_URL}\n`);

  const ticks = Math.floor(DURATION_SECONDS / INTERVAL_SECONDS);
  const startedAt = Date.now();

  for (let tick = 0; tick < ticks; tick++) {
    await Promise.all(vehicles.map(sendOne));
    console.log(`Tick ${tick + 1}/${ticks} — sent ${vehicles.length} requests, ${succeeded} ok / ${failed} failed so far`);
    if (tick < ticks - 1) await new Promise((r) => setTimeout(r, INTERVAL_SECONDS * 1000));
  }

  const totalSeconds = (Date.now() - startedAt) / 1000;
  console.log("\n=== Results ===");
  console.log(`Requests sent: ${succeeded + failed}`);
  console.log(`Succeeded: ${succeeded}`);
  console.log(`Failed: ${failed}`);
  console.log(`Error rate: ${(((failed) / (succeeded + failed)) * 100).toFixed(2)}%`);
  console.log(`Throughput: ${((succeeded + failed) / totalSeconds).toFixed(1)} req/s`);
  console.log(`Latency p50: ${percentile(latencies, 50)}ms`);
  console.log(`Latency p95: ${percentile(latencies, 95)}ms`);
  console.log(`Latency p99: ${percentile(latencies, 99)}ms`);
}

run();
