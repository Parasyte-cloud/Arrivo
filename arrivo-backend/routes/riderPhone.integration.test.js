// Run: DATABASE_URL=... node routes/riderPhone.integration.test.js
// The phone-on-file rule (services/riderPhone.js) against a real database:
// every way a rider can book either has a number or gets asked for one.
const assert = require("assert");
const http = require("http");
const jwt = require("jsonwebtoken");

process.env.JWT_SECRET = process.env.JWT_SECRET || "integration-test-secret";
// The Express request route answers 503 before anything else while this is off.
process.env.ARRIVO_NOW_ENABLED = "true";

const express = require("express");
require("express-async-errors");
const { pool, ready } = require("../db/db");

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
    passed++;
  } catch (e) {
    console.log(`FAIL  ${name}`);
    console.log(`      ${e.stack || e.message}`);
    process.exitCode = 1;
  }
}

const app = express();
app.use(express.json());
app.use("/api/rides", require("./rides"));
app.use("/api/instant-rides", require("./instantRides"));
app.use((err, req, res, next) => res.status(500).json({ error: "server error", detail: err.message }));
const server = http.createServer(app);
const { createRideFromAssistedBooking } = require("./payments");

async function call(path, { method = "POST", token, body } = {}) {
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const stamp = Date.now();
const made = [];
async function makeRider(tag, { phone = null, whatsapp = null, wallet = 0 } = {}) {
  const email = `rphone-${tag}-${stamp}-${Math.random().toString(36).slice(2)}@example.com`;
  const row = (await pool.query(
    `INSERT INTO users (name, email, password_hash, role, agreed_to_terms, email_verified, wallet_balance_naira, phone, whatsapp_number)
     VALUES ($1, $2, 'x', 'rider', true, true, $3, $4, $5) RETURNING id, token_version`,
    [`RPhone ${tag}`, email, wallet, phone, whatsapp]
  )).rows[0];
  made.push(row.id);
  const token = jwt.sign({ id: row.id, email, role: "rider", tv: row.token_version }, process.env.JWT_SECRET, { expiresIn: "1h" });
  return { id: row.id, token };
}
const phoneOf = async (id) => (await pool.query("SELECT phone FROM users WHERE id = $1", [id])).rows[0].phone;
const walletOf = async (id) => Number((await pool.query("SELECT wallet_balance_naira FROM users WHERE id = $1", [id])).rows[0].wallet_balance_naira);
const ridesOf = async (id) => Number((await pool.query("SELECT count(*)::int n FROM rides WHERE rider_id = $1", [id])).rows[0].n);

const TRIP = {
  bookingType: "one_way", vehicleType: "sedan", adults: 1, children: 0,
  pickupAddress: "Murtala Muhammed International Airport, Ikeja, Lagos", destinationAddress: "Victoria Island, Lagos",
};

(async () => {
  // Startup applies schema.sql; writing before it finishes can deadlock.
  await ready;
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    await test("quote: a rider with no number is asked for one", async () => {
      const r = await makeRider("quote");
      const res = await call("/api/rides/quote", { token: r.token, body: TRIP });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.code, "PHONE_REQUIRED");
    });

    await test("quote: a number sent with it is saved, and they aren't asked again", async () => {
      const r = await makeRider("save");
      const first = await call("/api/rides/quote", { token: r.token, body: { ...TRIP, riderPhone: "+2348012345678" } });
      assert.notStrictEqual(first.body.code, "PHONE_REQUIRED", JSON.stringify(first.body));
      assert.strictEqual(await phoneOf(r.id), "+2348012345678");
      const again = await call("/api/rides/quote", { token: r.token, body: TRIP });
      assert.notStrictEqual(again.body.code, "PHONE_REQUIRED");
    });

    await test("quote: a WhatsApp number alone is enough", async () => {
      const r = await makeRider("wa", { whatsapp: "+447700900123" });
      const res = await call("/api/rides/quote", { token: r.token, body: TRIP });
      assert.notStrictEqual(res.body.code, "PHONE_REQUIRED");
    });

    await test("book: a wallet booking carrying a fake reference and no phone is refused, nothing charged", async () => {
      const r = await makeRider("walletref", { wallet: 500000 });
      const res = await call("/api/rides", {
        token: r.token,
        body: { ...TRIP, paymentMethod: "wallet", paymentReference: "T_fake_reference_123", agreedCancellationPolicy: true, idempotencyKey: require("crypto").randomUUID() },
      });
      assert.strictEqual(res.status, 400, JSON.stringify(res.body));
      assert.strictEqual(res.body.code, "PHONE_REQUIRED");
      assert.strictEqual(await walletOf(r.id), 500000, "wallet must not move");
      assert.strictEqual(await ridesOf(r.id), 0, "no ride");
    });

    await test("book: a card booking that's already paid isn't held back over the phone", async () => {
      const r = await makeRider("card");
      const res = await call("/api/rides", {
        token: r.token,
        body: { ...TRIP, paymentMethod: "card", paymentReference: "T_some_paystack_ref_1", agreedCancellationPolicy: true },
      });
      // It may fail later for its own reasons (no Paystack here), just never for this.
      assert.notStrictEqual(res.body.code, "PHONE_REQUIRED", JSON.stringify(res.body));
    });

    await test("Express: a ride request with no phone is refused before the wallet is touched", async () => {
      const r = await makeRider("express", { wallet: 500000 });
      const res = await call("/api/instant-rides", {
        token: r.token,
        body: { paymentMethod: "wallet", pickup: { lat: 6.58, lng: 3.32 }, dropoff: { lat: 6.43, lng: 3.42 }, tier: "economy" },
      });
      assert.strictEqual(res.status, 400, JSON.stringify(res.body));
      assert.strictEqual(res.body.code, "PHONE_REQUIRED");
      assert.strictEqual(await walletOf(r.id), 500000);
    });

    await test("assisted booking: a paid booking becomes a ride, and its number lands on an account that had none", async () => {
      const r = await makeRider("assisted");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await createRideFromAssistedBooking(client, {
          rider_id: r.id, quoted_usd_amount: 30, quoted_ngn_per_usd: 1500,
          booking_request: { ...TRIP, durationDays: 1, passengerCount: 1, contactPhone: "+2348099998888" },
        }, `T_assisted_${stamp}`, 45000);
        await client.query("COMMIT");
        assert.strictEqual(await ridesOf(r.id), 1, "the paid booking must become a ride");
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      } finally { client.release(); }
      assert.strictEqual(await phoneOf(r.id), "+2348099998888");
    });

    await test("assisted booking: a number already on the account is never overwritten", async () => {
      const r = await makeRider("assisted2", { phone: "+2348011111111" });
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await createRideFromAssistedBooking(client, {
          rider_id: r.id, quoted_usd_amount: 30, quoted_ngn_per_usd: 1500,
          booking_request: { ...TRIP, durationDays: 1, passengerCount: 1, contactPhone: "+2348099998888" },
        }, `T_assisted2_${stamp}`, 45000);
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      } finally { client.release(); }
      assert.strictEqual(await phoneOf(r.id), "+2348011111111");
    });
  } finally {
    if (made.length) {
      await pool.query("DELETE FROM ride_team_events WHERE ride_id IN (SELECT id FROM rides WHERE rider_id = ANY($1))", [made]).catch(() => {});
      await pool.query("DELETE FROM ride_team WHERE ride_id IN (SELECT id FROM rides WHERE rider_id = ANY($1))", [made]).catch(() => {});
      await pool.query("DELETE FROM rides WHERE rider_id = ANY($1)", [made]).catch(() => {});
      await pool.query("DELETE FROM users WHERE id = ANY($1)", [made]).catch(() => {});
    }
    server.close();
    await pool.end();
    console.log(`\nriderPhone integration: ${passed} passed`);
  }
})();
