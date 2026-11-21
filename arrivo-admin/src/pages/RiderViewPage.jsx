import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../AuthContext";
import * as api from "../api";
import { RiderDrawer } from "./RidersPage";
import "../riders.css";

// Full-page rider profile for a workspace window or its own tab: #/rider/<id>.
export function RiderViewPage({ riderId }) {
  const { token, isReadOnly, can } = useAuth();
  const [rider, setRider] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const data = await api.getRiders(token);
      const list = Array.isArray(data) ? data : data.riders || [];
      const found = list.find((r) => String(r.id) === String(riderId));
      if (found) { setRider(found); setError(null); } else setError(`Rider ${riderId} was not found.`);
    } catch (e) {
      setError(e.message);
    }
  }, [token, riderId]);

  useEffect(() => { load(); }, [load]);

  if (error) return <div className="error-text" style={{ padding: 20 }}>{error}</div>;
  if (!rider) return <div className="empty-state">Loading rider…</div>;
  return (
    <RiderDrawer
      variant="page"
      rider={rider}
      token={token}
      isReadOnly={isReadOnly}
      canAdjustWallet={can("wallet", "manage")}
      onClose={() => { window.location.hash = "/riders"; }}
      onChanged={load}
    />
  );
}
