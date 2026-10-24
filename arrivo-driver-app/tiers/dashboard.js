// What the driver dashboard says about the daily subscription and the
// quarterly inspection, as plain rules.
//
// The server decides who is subscribed (arrivo-backend services/driverSubscription.js
// and routes/driverSubscription.js). This file only turns that answer into words,
// colours and one button. Import-free so tiers/dashboard.test.js can load it.

export function naira(amount) {
  const n = Number(amount);
  if (amount == null || amount === "" || !Number.isFinite(n)) return "";
  return `₦${String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}

// "3h 12m left", "45m left", "Under a minute left", or "" once the time has passed.
export function timeLeftLabel(endsAt, nowMs) {
  const end = endsAt == null ? NaN : new Date(endsAt).getTime();
  if (!Number.isFinite(end) || !Number.isFinite(nowMs)) return "";
  const ms = end - nowMs;
  if (ms <= 0) return "";
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "Under a minute left";
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}m left`;
  return `${h}h ${m}m left`;
}

// True once the end time has passed, so the screen can ask the server again at
// midnight instead of showing a stale "subscribed".
export function isExpired(sub, nowMs) {
  if (!sub || !sub.active || !sub.endsAt) return false;
  const end = new Date(sub.endsAt).getTime();
  return Number.isFinite(end) && nowMs >= end;
}

// Can this driver receive orders right now?
export function canReceiveOrders(sub, nowMs) {
  if (!sub) return false;
  if (sub.enforced === false) return true;
  return !!sub.active && !isExpired(sub, nowMs);
}

// The subscription card: title, detail line, tone, and the button (or null).
export function subscriptionView(sub, nowMs) {
  const price = naira(sub && sub.priceNaira != null ? sub.priceNaira : 2000);
  if (!sub) {
    return { state: "unknown", tone: "neutral", title: "Daily subscription", detail: "Checking your subscription...", button: null };
  }
  if (sub.enforced === false) {
    return { state: "free", tone: "ok", title: "Subscription not required", detail: "You can receive orders without subscribing for now.", button: null };
  }
  if (canReceiveOrders(sub, nowMs)) {
    const left = timeLeftLabel(sub.endsAt, nowMs);
    return {
      state: "active",
      tone: "ok",
      title: "Subscribed for today",
      detail: left ? `Ends at 12am. ${left}.` : "Ends at 12am.",
      button: null,
    };
  }
  return {
    state: "inactive",
    tone: "red",
    title: "Subscribe to receive orders",
    detail: `You are not subscribed for today. Pay ${price} to start receiving orders. It ends at 12am.`,
    button: `Subscribe ${price}`,
  };
}

// The red inspection reminder, or null when nothing is due yet.
export function inspectionView(inspection) {
  if (!inspection || inspection.severity !== "red") return null;
  const title =
    inspection.state === "overdue" ? "Inspection overdue"
    : inspection.state === "due_today" ? "Inspection due today"
    : inspection.state === "due_soon" ? "Inspection coming up"
    : "Inspection needed";
  return { tone: "red", title, detail: inspection.message || "", dueOn: inspection.dueOn || null };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// "24 Oct 2026" from "2026-10-24".
export function dayLabel(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ""));
  if (!m) return "";
  const month = MONTHS[Number(m[2]) - 1];
  return month ? `${Number(m[3])} ${month} ${m[1]}` : "";
}

// Trips as a short phrase: "0 trips", "1 trip", "12 trips".
export function tripsLabel(n) {
  const v = Number(n) || 0;
  return v === 1 ? "1 trip" : `${v} trips`;
}

// A payment started but the app was closed before it could be confirmed with the
// server. The reference is kept so it can be confirmed on the next open.
export function isPlausibleReference(ref) {
  return typeof ref === "string" && /^[A-Za-z0-9=_-][A-Za-z0-9._=-]{3,99}$/.test(ref) && !ref.includes("..");
}
