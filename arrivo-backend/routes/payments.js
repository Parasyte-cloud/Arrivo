const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const { pool } = require("../db/db");
const router = express.Router();

const PAYSTACK_BASE = "https://api.paystack.co";

function paystackHeaders() {
  return { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` };
}

// Shared by GET /verify/:reference below and PATCH /api/rides/:id/payment
// (routes/rides.js) — the one place that actually calls Paystack to find
// out whether a transaction really succeeded. Never trust a client's word
// for this; always ask Paystack.
async function verifyPaystackTransaction(reference) {
  const response = await axios.get(`${PAYSTACK_BASE}/transaction/verify/${reference}`, {
    headers: paystackHeaders(),
  });
  const data = response.data.data;
  return {
    success: data.status === "success",
    status: data.status,
    amountNaira: data.amount / 100,
    currency: data.currency,
    paidAt: data.paid_at,
  };
}

// POST /api/payments/initialize
// body: { email, amountNaira, reference? }
// Call this from the app right before showing checkout. Returns an
// authorization_url to open in a browser/webview, and a reference to verify later.
router.post("/initialize", async (req, res) => {
  const { email, amountNaira } = req.body;

  if (!email || !amountNaira) {
    return res.status(400).json({ error: "email and amountNaira are required" });
  }
  if (!process.env.PAYSTACK_SECRET_KEY || process.env.PAYSTACK_SECRET_KEY.includes("replace_me")) {
    return res.status(500).json({ error: "PAYSTACK_SECRET_KEY is not configured on the server" });
  }

  try {
    const response = await axios.post(
      `${PAYSTACK_BASE}/transaction/initialize`,
      {
        email,
        amount: Math.round(amountNaira * 100), // Paystack expects kobo
        callback_url: process.env.PAYSTACK_CALLBACK_URL,
      },
      { headers: paystackHeaders() }
    );

    const { authorization_url, access_code, reference } = response.data.data;
    res.json({ authorizationUrl: authorization_url, accessCode: access_code, reference });
  } catch (err) {
    console.error("Paystack initialize failed:", err.response?.data || err.message);
    res.status(502).json({ error: "Could not start payment. Please try again." });
  }
});

// GET /api/payments/verify/:reference
// Call this after the checkout browser closes, to confirm the payment
// actually succeeded before marking a ride as paid. Never trust the
// frontend's word alone that a payment succeeded.
router.get("/verify/:reference", async (req, res) => {
  try {
    const result = await verifyPaystackTransaction(req.params.reference);
    res.json(result);
  } catch (err) {
    console.error("Paystack verify failed:", err.response?.data || err.message);
    res.status(502).json({ error: "Could not verify payment." });
  }
});

// POST /api/payments/webhook
// Configure this URL in the Paystack dashboard (Settings > API Keys & Webhooks).
// This is the RELIABLE way to know a payment succeeded — it fires even if
// the user closes the app mid-checkout. Always verify the signature.
router.post(
  "/webhook",
  express.raw({ type: "application/json" }), // need the raw body to check the signature
  async (req, res) => {
    const signature = req.headers["x-paystack-signature"];
    const expected = crypto
      .createHmac("sha512", process.env.PAYSTACK_SECRET_KEY || "")
      .update(req.body)
      .digest("hex");

    if (signature !== expected) {
      console.warn("Webhook signature mismatch — ignoring request");
      return res.sendStatus(401);
    }

    const event = JSON.parse(req.body.toString());
    if (event.event === "charge.success") {
      const { reference, amount, customer } = event.data;

      // This only UPDATES an existing ride — it can't create one from
      // scratch, since the app currently creates the ride row itself only
      // after the client-side verify step succeeds (see CheckoutScreen's
      // verifyAndCreateRide). So this webhook is a backstop for a ride that
      // already exists with this payment_reference (e.g. the client-side
      // verify call failed/timed out after the ride was created but before
      // its status got updated) — not yet a full replacement for that flow.
      // If a rider closes the app before ever returning from Paystack
      // checkout, no ride is created either way, webhook or not — fixing
      // that needs rides to be created as "pending" before redirecting to
      // Paystack, which is a bigger flow change than this webhook alone.
      try {
        // Check the amount BEFORE writing anything — an underpaid or
        // wrong-amount transaction must never flip a ride to "paid", not
        // just get logged after the fact. SELECT first (no write yet).
        const existing = await pool.query(
          "SELECT id, fare_naira, payment_status FROM rides WHERE payment_reference = $1",
          [reference]
        );
        const ride = existing.rows[0];
        if (!ride) {
          console.log(`Payment confirmed via webhook for ref ${reference}, but no matching ride found yet.`);
        } else if (ride.payment_status === "paid") {
          // Already marked paid (e.g. by a previous webhook delivery) — Paystack
          // retries webhooks, so this must be a safe no-op, not an error.
        } else {
          const expectedKobo = Math.round(Number(ride.fare_naira) * 100);
          if (Number(amount) !== expectedKobo) {
            console.error(
              `Webhook amount mismatch for ride #${ride.id}: paid ${amount} kobo, expected ${expectedKobo} kobo — NOT marking paid.`
            );
          } else {
            await pool.query(
              `UPDATE rides SET payment_status = 'paid', updated_at = now()
               WHERE id = $1 AND payment_status != 'paid'`,
              [ride.id]
            );
            console.log(`Payment confirmed via webhook: ride #${ride.id}, ref ${reference} - NGN ${amount / 100} - ${customer.email}`);
          }
        }
      } catch (e) {
        console.error("Webhook DB update failed:", e.message);
      }
    }

    res.sendStatus(200);
  }
);

module.exports = router;
module.exports.verifyPaystackTransaction = verifyPaystackTransaction;
