// USD/NGN conversion — used to show international riders a $ estimate next
// to (never instead of) the real naira fare. RideArrivo's actual money —
// fares, wallet balance, what Paystack actually charges — is ALWAYS naira.
// The dollar figure this module produces is DISPLAY-ONLY, same "never trust
// a converted number for the real charge" principle as everything else in
// this fare/payment stack: a foreign card gets charged the naira amount,
// and the card network/issuing bank does its own conversion on the rider's
// statement, exactly like any other naira charge on a foreign card today.
//
// Rate source: exchangerate-api.com's free "open access" endpoint, no key
// required, refreshed roughly daily. Cached in memory for a few hours so
// normal traffic doesn't hit it on every request. If the fetch fails
// (network hiccup, provider down), fall back to FALLBACK_NGN_PER_USD below
// rather than failing the request — this is a business number, not a
// technical one, and should be nudged back toward reality every so often
// if you ever notice the live fetch has been down for a while (search
// "usd to ngn" to check the current rate).
const axios = require("axios");

const FALLBACK_NGN_PER_USD = 1380; // approx. as of July 2026 — update periodically if the live fetch stays down

const CACHE_MS = 6 * 60 * 60 * 1000; // 6 hours
let cachedRate = null;
let cachedAt = 0;

async function fetchLiveRate() {
  const response = await axios.get("https://open.er-api.com/v6/latest/USD", { timeout: 5000 });
  const rate = response.data?.rates?.NGN;
  if (!rate || typeof rate !== "number") {
    throw new Error("FX response missing a usable NGN rate");
  }
  return rate;
}

// Naira per 1 USD. Always resolves — never rejects — falling back to the
// last good cached rate, or the hardcoded constant if we've never
// successfully fetched one.
async function getNgnPerUsd() {
  const now = Date.now();
  if (cachedRate && now - cachedAt < CACHE_MS) return cachedRate;
  try {
    const rate = await fetchLiveRate();
    cachedRate = rate;
    cachedAt = now;
    return rate;
  } catch (err) {
    console.error("FX rate fetch failed, using fallback/cached rate:", err.message);
    return cachedRate || FALLBACK_NGN_PER_USD;
  }
}

async function nairaToUsd(naira) {
  const rate = await getNgnPerUsd();
  return naira / rate;
}

async function usdToNaira(usd) {
  const rate = await getNgnPerUsd();
  return usd * rate;
}

module.exports = { getNgnPerUsd, nairaToUsd, usdToNaira, FALLBACK_NGN_PER_USD };
