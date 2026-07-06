import { useEffect, useState } from "react";
import { useAuth } from "../AuthContext";
import * as api from "../api";
import { StatCard } from "../components/StatCard";

const STATUS_LABELS = {
  requested: "Requested",
  accepted: "Accepted",
  in_progress: "In progress",
  completed: "Completed",
  cancelled: "Cancelled",
};

export function AnalyticsPage() {
  const { token } = useAuth();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.getAnalytics(token).then(setData).catch((e) => setError(e.message));
  }, [token]);

  if (error) return <div className="error-text">{error}</div>;
  if (!data) return <div className="empty-state">Loading analytics…</div>;

  return (
    <div>
      <div className="page-header">
        <div>
          <span className="eyebrow">Platform health</span>
          <h1>Analytics</h1>
        </div>
      </div>

      <div className="stat-grid">
        <StatCard label="This month's revenue" value={`₦${data.revenueThisMonthNaira.toLocaleString()}`} accent="var(--amber)" />
        <StatCard label="All-time revenue" value={`₦${data.totalRevenueNaira.toLocaleString()}`} />
        <StatCard label="Riders" value={data.riders} />
        <StatCard label="Drivers" value={data.drivers} />
        <StatCard label="Verified drivers" value={data.verifiedDrivers} accent="var(--teal)" />
        <StatCard label="Online now" value={data.onlineDrivers} accent="var(--teal)" />
      </div>

      <h2 style={{ fontSize: 15, marginBottom: 12 }}>Rides by status</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Status</th><th>Count</th></tr>
          </thead>
          <tbody>
            {Object.entries(STATUS_LABELS).map(([key, label]) => (
              <tr key={key}>
                <td>{label}</td>
                <td>{data.ridesByStatus[key] || 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
