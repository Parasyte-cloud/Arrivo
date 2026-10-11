// Small pure helpers for the Ride Desk, kept out of the component so they can be tested.

export function firstName(name) {
  return String(name || "").trim().split(/\s+/)[0] || "";
}

// "Say hello to Ada", the line staff see above a person's name so they open the
// conversation by name.
export function greeting(person) {
  const n = firstName(person && (person.firstName || person.name));
  return n ? `Say hello to ${n}` : "Greet them by name";
}

export function callOutcome(c) {
  const who = c.byStaff ? `${c.from} to ${c.to}` : `${c.from} and ${c.to}`;
  switch (c.status) {
    case "ended": return `${who} spoke for ${formatSeconds(c.seconds)}`;
    case "connected": return `${who}, in progress`;
    case "ringing": return `${who}, ringing`;
    case "missed": return `${who}, not answered`;
    case "declined": return `${who}, declined`;
    case "cancelled": return `${who}, cancelled`;
    case "failed": return `${who}, did not connect${c.reason ? ` (${String(c.reason).replace(/_/g, " ")})` : ""}`;
    default: return `${who}, ${c.status}`;
  }
}

export function formatSeconds(s) {
  const n = Math.max(0, Number(s) || 0);
  if (n < 60) return `${n}s`;
  return `${Math.floor(n / 60)}m ${String(n % 60).padStart(2, "0")}s`;
}

export function statusLabel(status) {
  return String(status || "").replace(/_/g, " ");
}

// Tabs by who is looking. Everyone gets their own rides, all rides and the
// waiting queue; the head of support and admins also get the team and the log.
export function tabsFor({ role, isLead }) {
  const base = [
    { id: "mine", label: "My rides" },
    { id: "all", label: "All rides" },
    { id: "unassigned", label: "Waiting" },
    { id: "team", label: "Team" },
  ];
  if (role === "admin" || isLead) base.push({ id: "log", label: "Number access log" });
  if (role === "admin" || isLead) base.push({ id: "people", label: "People" });
  return base;
}

// Which team can this person move rides for?
export function reassignableTeams({ role, isLead }) {
  if (role === "admin") return ["support", "operations"];
  if (role === "support" && isLead) return ["support"];
  return [];
}

export function canManageDuty({ role, isLead }, target) {
  if (role === "admin") return true;
  return role === "support" && !!isLead && target.role === "support";
}

// "Tola (Support) and Chidi (Operations)"
export function teamLine(team) {
  const parts = [];
  if (team && team.support) parts.push(`${team.support.firstName} (Support)`);
  if (team && team.operations) parts.push(`${team.operations.firstName} (Operations)`);
  return parts.length ? parts.join(" and ") : "Waiting for a team";
}

// Roles the viewer may move this person to. Mirrors the server's rules (the
// server decides; this only keeps buttons honest). "rider" means remove.
//   me: { isOwner, canManage }   target: { id, role, is_owner }
export function roleOptions(me, target, selfId) {
  if (!me || !me.canManage || !target || target.is_owner || target.id === selfId) return [];
  const all = me.isOwner ? ["admin", "support", "operations"] : ["support", "operations"];
  if (!me.isOwner && target.role === "admin") return [];
  return all.filter((r) => r !== target.role);
}
