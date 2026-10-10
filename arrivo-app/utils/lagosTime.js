// Lagos wall-clock time for booking screens.
//
// A pickup time typed into the app is a time in Lagos (WAT, UTC+1, no daylight
// saving) whatever timezone the phone is set to. Building it with
// new Date(...).setHours() reads it in the phone's own zone, so a rider on a
// UK phone who picks 09:00 would send 09:00 London, an hour off the car they
// meant. Everything here works in Lagos time instead.
//
// The native date and time pickers hand back Date objects in the phone's zone.
// We treat their year, month, day, hour and minute fields as the Lagos clock
// the rider chose, and only the final instant is converted. wallClockDate()
// goes the other way, to seed a picker or set its minimumDate.
//
// Import-free on purpose so utils/lagosTime.test.js can load it with node.

const HOUR_MS = 60 * 60 * 1000;
const LAGOS_OFFSET_HOURS = 1;

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function pad(n) {
  return n < 10 ? `0${n}` : String(n);
}

// The Lagos calendar fields at a real instant.
export function lagosParts(at = Date.now()) {
  const ms = at instanceof Date ? at.getTime() : at;
  const d = new Date(ms + LAGOS_OFFSET_HOURS * HOUR_MS);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    weekday: d.getUTCDay(),
  };
}

// Real instant for a Lagos wall-clock time. Returns null for impossible values
// (month 13, 25:00, 31 February), which Date.UTC would quietly roll forward.
export function lagosInstant(year, month, day, hour, minute) {
  const ms = Date.UTC(year, month - 1, day, hour - LAGOS_OFFSET_HOURS, minute);
  if (!Number.isFinite(ms)) return null;
  const back = lagosParts(ms);
  if (back.year !== year || back.month !== month || back.day !== day || back.hour !== hour || back.minute !== minute) {
    return null;
  }
  return new Date(ms);
}

// Date and time pickers return separate Date objects. Their local fields are
// the Lagos clock the rider chose.
export function combineLagos(datePart, timePart) {
  if (!datePart || !timePart) return null;
  return lagosInstant(
    datePart.getFullYear(),
    datePart.getMonth() + 1,
    datePart.getDate(),
    timePart.getHours(),
    timePart.getMinutes()
  );
}

// A Date whose phone-zone fields read as the Lagos clock at that instant. Use
// it as a picker's value or minimumDate so the picker shows Lagos time.
export function wallClockDate(at = Date.now()) {
  const p = lagosParts(at);
  return new Date(p.year, p.month - 1, p.day, p.hour, p.minute, 0, 0);
}

// Today in Lagos, as a wall-clock Date at midnight.
export function lagosToday(now = Date.now()) {
  const p = lagosParts(now);
  return new Date(p.year, p.month - 1, p.day, 0, 0, 0, 0);
}

// "Sat 10 Oct" for the Lagos day that is `offset` days from today.
export function lagosDayLabel(offset, now = Date.now()) {
  const p = lagosParts(now);
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + offset));
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

// Instant for "today in Lagos plus offset days, at hour:minute". Hour and
// minute can arrive as free text, so anything that is not a whole 0-23 / 0-59
// number gives null instead of a guessed time.
export function lagosScheduleInstant(dayOffset, hourText, minuteText, now = Date.now()) {
  const hour = Number(hourText);
  const minute = Number(minuteText);
  if (String(hourText).trim() === "" || !Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  if (String(minuteText).trim() === "" || !Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  const p = lagosParts(now);
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + dayOffset));
  return lagosInstant(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), hour, minute);
}

// "Sat 10 Oct, 14:30 (Lagos time)"
export function formatLagos(at) {
  if (at == null) return "";
  const ms = at instanceof Date ? at.getTime() : new Date(at).getTime();
  if (!Number.isFinite(ms)) return "";
  const p = lagosParts(ms);
  return `${DAYS[p.weekday]} ${p.day} ${MONTHS[p.month - 1]}, ${pad(p.hour)}:${pad(p.minute)} (Lagos time)`;
}

// Next mark (five minutes by default) at least `hours` from now, so a "use the
// earliest time" button never lands a hair under the limit by the time it is
// tapped. Route offers quarter-hour minutes, so it passes 15.
export function earliestInstant(hours, now = Date.now(), stepMinutes = 5) {
  const step = stepMinutes * 60 * 1000;
  return new Date(Math.ceil((now + hours * HOUR_MS) / step) * step);
}
