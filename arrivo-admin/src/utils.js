// hour12 is set explicitly everywhere this is used — without it,
// toLocaleTimeString/toLocaleString fall back to whatever locale the
// browser/OS resolves to, which on the deployed build was silently
// rendering 24-hour time even though AM/PM display was intended.
//
// Separately, the browser's own AM/PM casing isn't guaranteed — with no
// locale pinned, toLocaleTimeString renders it however the visiting
// browser/OS's regional settings say to (some render "pm" lowercase),
// which is why the same admin panel could show "07:56 pm" on one machine
// and "07:56 PM" on another. This forces it uppercase everywhere instead
// of leaving it to whatever locale the viewer happens to have.
function forceUppercaseMeridiem(timeString) {
  return timeString.replace(/\b(am|pm)\b/i, (m) => m.toUpperCase());
}

export function formatDateTime(isoString) {
  const d = new Date(isoString);
  const date = d.toLocaleDateString();
  const time = forceUppercaseMeridiem(d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: true }));
  return `${date} · ${time}`;
}

export function formatTime(isoString) {
  return forceUppercaseMeridiem(new Date(isoString).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: true }));
}

// Builds a CSV from an array of rows and triggers a browser download.
// `columns` is [{ label, value(row) }] so each page controls exactly what
// gets exported and how any nested/computed fields get flattened — same
// technique RidersPage's waitlist export already used, just generalized so
// Riders/Drivers/Rides don't each reimplement blob+anchor download logic.
export function downloadCsv(filename, rows, columns) {
  const escape = (val) => {
    const s = val === null || val === undefined ? "" : String(val);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = columns.map((c) => c.label).join(",");
  const lines = rows.map((row) => columns.map((c) => escape(c.value(row))).join(","));
  const csv = [header, ...lines].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
