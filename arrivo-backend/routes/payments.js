const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const router = express.Router();

const PAYSTACK_BASE = "https://api.paystack.co";

function paystackHeaders() {
  return { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` };
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
  const { reference } = req.params;

  try {
    const response = await axios.get(`${PAYSTACK_BASE}/transaction/verify/${reference}`, {
      headers: paystackHeaders(),
    });

    const data = response.data.data;
    const success = data.status === "success";

    res.json({
      success,
      status: data.status,
      amountNaira: data.amount / 100,
      currency: data.currency,
      paidAt: data.paid_at,
      // TODO: once you have a database, look up the expected fare for this
      // reference here and compare against data.amount before marking paid.
    });
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
  (req, res) => {
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
      console.log(`Payment confirmed via webhook: ${reference} - NGN ${amount / 100} - ${customer.email}`);
      // TODO: mark the matching ride/booking as paid in your database here.
    }

    res.sendStatus(200);
  }
);

module.exports = router;
