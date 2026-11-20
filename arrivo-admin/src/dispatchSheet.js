// Builds the offline dispatch sheet: one self-contained HTML page (no scripts,
// no network) that still opens when the console is down. Escapes everything,
// since names and addresses are typed by riders.
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function buildDispatchSheet({ generatedAt, trips }) {
  const when = new Date(generatedAt).toLocaleString("en-GB", { timeZone: "Africa/Lagos" });
  const rows = trips.map((t) => {
    const stops = Array.isArray(t.stops) ? t.stops.map((s) => (typeof s === "string" ? s : s?.address || "")).filter(Boolean) : [];
    return `<tr${t.panic ? ' class="panic"' : ""}>
<td>#${esc(t.id)}${t.panic ? "<br><b>PANIC</b>" : ""}</td>
<td>${esc(t.status)}${t.flight ? `<br>${esc(t.flight)}` : ""}${t.scheduledAt ? `<br>${esc(new Date(t.scheduledAt).toLocaleString("en-GB", { timeZone: "Africa/Lagos" }))}` : ""}</td>
<td>${esc(t.pickup)}${stops.length ? `<br>to ${stops.map(esc).join(", ")}` : ""}</td>
<td>${esc(t.riderName)}<br>${esc(t.riderPhone)}${t.emergencyPhone ? `<br>Emergency: ${esc(t.emergencyName)} ${esc(t.emergencyPhone)}` : ""}</td>
<td>${t.driverName ? `${esc(t.driverName)}<br>${esc(t.driverPhone)}<br>${esc(t.car)}` : "Not assigned"}</td>
</tr>`;
  }).join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Arrivo dispatch sheet</title>
<style>body{font:14px/1.4 system-ui,sans-serif;margin:16px;color:#12123b}h1{font-size:18px;margin:0}p{margin:4px 0 12px}
table{border-collapse:collapse;width:100%}th,td{border:1px solid #999;padding:6px;text-align:left;vertical-align:top}th{background:#eee}
tr.panic td{background:#ffe3e3}@media print{body{margin:0}}</style></head><body>
<h1>Arrivo dispatch sheet</h1>
<p>Snapshot taken ${esc(when)} (Lagos time). It does not update. Contains customer phone numbers: keep it private and delete it when the outage is over.</p>
<table><thead><tr><th>Ride</th><th>Status</th><th>Route</th><th>Rider</th><th>Driver</th></tr></thead><tbody>
${rows || '<tr><td colspan="5">No live rides at this moment.</td></tr>'}
</tbody></table></body></html>`;
}

export function downloadDispatchSheet(data) {
  const blob = new Blob([buildDispatchSheet(data)], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `arrivo-dispatch-sheet-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "")}.html`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
