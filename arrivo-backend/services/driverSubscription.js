// Rules for the driver daily subscription and the quarterly inspection.
//
// A subscription is one Lagos calendar day. It is paid for the day it is
// bought and ends at 00:00 Lagos time. Lagos is UTC+1 all year (no DST), so a
// day boundary is a fixed hour offset and needs no time zone library.
//
// Kept free of database and network code so the rules can be tested alone.

const DAILY_PRICE_NAIRA = 2000;
const LAGOS_OFFSET_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// Drivers must come in once per quarter, so every 3 months.
const INSPECTION_INTERVAL_MONTHS = 3;
// The red reminder starts this many days before the inspection is due.
const INSPECTION_WARNING_DAYS = 7;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function toMs(now) {
  const ms = now instanceof Date ? now.getTime() : Number(now);
  return Number.isFinite(ms) ? ms : null;
}

// "2026-10-24": the Lagos calendar day that instant falls on.
function lagosDay(now = Date.now()) {
  const ms = toMs(now);
  if (ms === null) throw new Error("lagosDay needs a valid time");
  return new Date(ms + LAGOS_OFFSET_MS).toISOString().slice(0, 10);
}

// The instant the Lagos day containing `now` ends (the next 00:00 Lagos).
function endOfLagosDay(now = Date.now()) {
  const ms = toMs(now);
  if (ms === null) throw new Error("endOfLagosDay needs a valid time");
  const shifted = ms + LAGOS_OFFSET_MS;
  const nextMidnightShifted = Math.floor(shifted / DAY_MS) * DAY_MS + DAY_MS;
  return new Date(nextMidnightShifted - LAGOS_OFFSET_MS);
}

function isDayString(value) {
  if (typeof value !== "string" || !DAY_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

// Whether any of the paid days is today (Lagos). `paidDays` may hold "YYYY-MM-DD"
// strings or Dates.
function isSubscribedOn(paidDays, now = Date.now()) {
  if (!Array.isArray(paidDays)) return false;
  const today = lagosDay(now);
  return paidDays.some((d) => dayKey(d) === today);
}

function dayKey(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return typeof value === "string" ? value.slice(0, 10) : "";
}

function subscriptionStatus(paidDays, now = Date.now()) {
  const active = isSubscribedOn(paidDays, now);
  return {
    active,
    day: lagosDay(now),
    priceNaira: DAILY_PRICE_NAIRA,
    endsAt: active ? endOfLagosDay(now).toISOString() : null,
  };
}

// Adds whole calendar months to a "YYYY-MM-DD" day, clamping to month end
// (31 Jan + 1 month = 28/29 Feb), so a quarterly cycle never skips a month.
function addMonths(day, months) {
  if (!isDayString(day)) throw new Error("addMonths needs a YYYY-MM-DD day");
  const [y, m, d] = day.split("-").map(Number);
  const total = (m - 1) + months;
  const year = y + Math.floor(total / 12);
  const month = ((total % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const out = new Date(Date.UTC(year, month, Math.min(d, lastDay)));
  return out.toISOString().slice(0, 10);
}

function inspectionDueOn(lastInspectionDay) {
  return addMonths(lastInspectionDay, INSPECTION_INTERVAL_MONTHS);
}

function wholeDaysBetween(fromDay, toDay) {
  return Math.round((Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${fromDay}T00:00:00Z`)) / DAY_MS);
}

// state: not_recorded | ok | due_soon | due_today | overdue
// `severity` is "red" for everything the driver must act on.
function inspectionStatus(lastInspectionDay, now = Date.now()) {
  if (!lastInspectionDay) {
    return { state: "not_recorded", severity: "red", dueOn: null, daysLeft: null, message: "No inspection on record. Please visit us for your inspection." };
  }
  const last = dayKey(lastInspectionDay);
  if (!isDayString(last)) {
    return { state: "not_recorded", severity: "red", dueOn: null, daysLeft: null, message: "No inspection on record. Please visit us for your inspection." };
  }
  const dueOn = inspectionDueOn(last);
  const daysLeft = wholeDaysBetween(lagosDay(now), dueOn);
  if (daysLeft < 0) {
    const n = -daysLeft;
    return { state: "overdue", severity: "red", dueOn, daysLeft, message: `Inspection overdue by ${n} ${n === 1 ? "day" : "days"}. Please come in now.` };
  }
  if (daysLeft === 0) {
    return { state: "due_today", severity: "red", dueOn, daysLeft, message: "Your inspection is due today. Please come in." };
  }
  if (daysLeft <= INSPECTION_WARNING_DAYS) {
    return { state: "due_soon", severity: "red", dueOn, daysLeft, message: `Inspection due in ${daysLeft} ${daysLeft === 1 ? "day" : "days"}. Please book your visit.` };
  }
  return { state: "ok", severity: "none", dueOn, daysLeft, message: "" };
}

module.exports = {
  DAILY_PRICE_NAIRA,
  INSPECTION_INTERVAL_MONTHS,
  INSPECTION_WARNING_DAYS,
  lagosDay,
  endOfLagosDay,
  isDayString,
  isSubscribedOn,
  subscriptionStatus,
  addMonths,
  inspectionDueOn,
  inspectionStatus,
};
