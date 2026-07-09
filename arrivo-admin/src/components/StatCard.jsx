export function StatCard({ label, value, accent }) {
  return (
    <div className="stat-card">
      <div className="stat-num" style={accent ? { color: accent } : undefined}>{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}
