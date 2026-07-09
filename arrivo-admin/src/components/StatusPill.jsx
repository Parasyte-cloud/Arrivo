export function StatusPill({ label, tone = "muted" }) {
  return (
    <span className={`pill ${tone}`}>
      <span className="dot" />
      {label}
    </span>
  );
}

// Central place mapping raw ride/driver status strings to a tone —
// keeps color meaning consistent everywhere it's used.
export function rideStatusTone(status) {
  switch (status) {
    case "completed": return "teal";
    case "in_progress": return "amber";
    case "accepted": return "amber";
    case "cancelled": return "coral";
    default: return "muted"; // requested
  }
}
