import { useEffect, useState } from "react";
import * as Localization from "expo-localization";
import { getFxRate } from "../services/api";

// Detects whether a rider is booking from Nigeria vs. outside it using the
// device's locale/region setting (Settings > Language & Region) — the
// simplest signal, no extra permissions, matches the product decision made
// for this feature. Nigerian-region devices see naira only; everyone else
// sees a $ estimate, converted at the live rate from GET /api/rides/fx-rate.
//
// IMPORTANT: naira is always the real, charged amount throughout this app —
// this hook only controls what's DISPLAYED to the rider. Ride creation,
// wallet balance, and what Paystack actually charges are untouched by any
// of this (see arrivo-backend/services/fx.js for the full reasoning).
export function useCurrency(token) {
  const region = Localization.getLocales()[0]?.regionCode;
  const isNigeria = region === "NG";
  const [ngnPerUsd, setNgnPerUsd] = useState(null);

  useEffect(() => {
    if (isNigeria || !token) return; // no need to fetch a rate for naira-only display
    getFxRate(token)
      .then((r) => setNgnPerUsd(r.ngnPerUsd))
      .catch(() => {}); // formatFare below just keeps showing naira if this never resolves
  }, [isNigeria, token]);

  // "₦72,000" in Nigeria, "$52.17" outside it once the rate has loaded —
  // falls back to naira until then rather than showing a stale/wrong $ figure.
  function formatFare(amountNaira) {
    const naira = Number(amountNaira || 0);
    if (isNigeria || !ngnPerUsd) return "₦" + Math.round(naira).toLocaleString();
    return "$" + (naira / ngnPerUsd).toFixed(2);
  }

  // For a PAST ride (trip history, receipts) rather than a live quote.
  // formatFare() above always converts at TODAY's rate, which is correct
  // for a quote in progress but wrong for something already booked — a
  // rider looking at an old trip weeks later would see a $ figure that
  // drifted from what they actually saw at booking, even though the naira
  // charge never changes. quotedUsdAmount is the real snapshot taken at
  // booking time (see quoted_usd_amount in routes/rides.js) — use that
  // instead of recomputing whenever it's available. Rides booked before
  // this shipped have no snapshot, so those still fall back to a live
  // estimate rather than showing nothing.
  function formatRideFare(fareNaira, quotedUsdAmount) {
    const naira = Number(fareNaira || 0);
    if (isNigeria) return "₦" + Math.round(naira).toLocaleString();
    if (quotedUsdAmount != null) return "₦" + Math.round(naira).toLocaleString() + " (~$" + Number(quotedUsdAmount).toFixed(2) + ")";
    return formatFare(naira);
  }

  return { isNigeria, ngnPerUsd, formatFare, formatRideFare };
}
