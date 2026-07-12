import { useCallback, useEffect, useRef, useState } from "react";
import { MapContainer, TileLayer, Marker, Popup } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useAuth } from "../AuthContext";
import * as api from "../api";
import { PhoneLink } from "../components/PhoneLink";

// Leaflet's default marker icon references image paths that don't resolve
// correctly once bundled by Vite — this is a well-known issue, not
// something specific to this app. Rebuilding the icon URLs from the
// installed package's own assets is the standard fix.
import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
import markerIcon from "leaflet/dist/images/marker-icon.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";

const normalIcon = new L.Icon({
  iconUrl: markerIcon,
  iconRetinaUrl: markerIcon2x,
  shadowUrl: markerShadow,
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
});

// A visually distinct red marker for any ride with an active panic — this
// is the one situation where someone glancing at the map needs their eye
// drawn to it immediately, not treated the same as a normal trip.
const panicIcon = new L.Icon({
  iconUrl: "data:image/svg+xml;base64," + btoa(`
    <svg xmlns="http://www.w3.org/2000/svg" width="25" height="41" viewBox="0 0 25 41">
      <path d="M12.5 0C5.6 0 0 5.6 0 12.5c0 9.4 12.5 28.5 12.5 28.5S25 21.9 25 12.5C25 5.6 19.4 0 12.5 0z" fill="#D64545"/>
      <circle cx="12.5" cy="12.5" r="6" fill="#fff"/>
    </svg>
  `),
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
});

const LAGOS_CENTER = [6.5244, 3.3792];
const POLL_INTERVAL_MS = 15000; // matches how often the driver app reports GPS (~20s) — no point polling faster

function timeAgo(isoString) {
  if (!isoString) return null;
  const minutes = Math.round((Date.now() - new Date(isoString).getTime()) / 60000);
  if (minutes < 1) return "just now";
  if (minutes === 1) return "1 minute ago";
  return `${minutes} minutes ago`;
}

export function LiveMapPage() {
  const { token } = useAuth();
  const [rides, setRides] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const cancelledRef = useRef(false);

  const load = useCallback(async () => {
    try {
      const { rides } = await api.getLiveRides(token);
      if (cancelledRef.current) return;
      setRides(rides);
      setLastUpdated(new Date());
      setError(null);
    } catch (e) {
      if (!cancelledRef.current) setError(e.message);
    } finally {
      if (!cancelledRef.current) setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    cancelledRef.current = false;
    load();
    const interval = setInterval(load, POLL_INTERVAL_MS);
    return () => { cancelledRef.current = true; clearInterval(interval); };
  }, [load]);

  const withLocation = rides.filter((r) => r.current_lat && r.current_lng);
  const withoutLocation = rides.filter((r) => !r.current_lat || !r.current_lng);

  return (
    <div>
      <div className="page-header">
        <div>
          <span className="eyebrow">Fleet oversight</span>
          <h1>Live Map</h1>
        </div>
        {lastUpdated ? (
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
            Updated {lastUpdated.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: true })} · refreshes every 15s
          </span>
        ) : null}
      </div>

      <div className="stat-grid" style={{ marginBottom: 20 }}>
        <div className="stat-card">
          <div className="stat-num">{rides.length}</div>
          <div className="stat-label">Rides in progress</div>
        </div>
        <div className="stat-card">
          <div className="stat-num" style={{ color: "var(--coral)" }}>{rides.filter((r) => r.has_active_panic).length}</div>
          <div className="stat-label">With an active panic</div>
        </div>
        <div className="stat-card">
          <div className="stat-num" style={{ color: withoutLocation.length > 0 ? "var(--coral)" : undefined }}>{withoutLocation.length}</div>
          <div className="stat-label">Missing a GPS position</div>
        </div>
      </div>

      {error ? <div className="error-text" style={{ marginBottom: 12 }}>{error}</div> : null}

      {loading ? (
        <div className="table-wrap"><div className="empty-state">Loading live positions…</div></div>
      ) : rides.length === 0 ? (
        <div className="table-wrap"><div className="empty-state">No rides in progress right now.</div></div>
      ) : (
        <div style={{ borderRadius: "var(--radius)", overflow: "hidden", border: "1px solid var(--card-border)" }}>
          <MapContainer center={LAGOS_CENTER} zoom={11} style={{ height: 560, width: "100%" }}>
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />
            {withLocation.map((r) => (
              <Marker key={r.id} position={[r.current_lat, r.current_lng]} icon={r.has_active_panic ? panicIcon : normalIcon}>
                <Popup>
                  <div style={{ minWidth: 200, fontSize: 13 }}>
                    {r.has_active_panic ? (
                      <div style={{ color: "var(--coral)", fontWeight: 700, marginBottom: 6 }}>🚨 Active panic alert</div>
                    ) : null}
                    <div style={{ fontWeight: 700, marginBottom: 4 }}>Ride #{r.id}</div>
                    <div style={{ marginBottom: 6 }}>{r.pickup_address}</div>
                    <div style={{ color: "#666", fontSize: 11.5, textTransform: "uppercase", marginBottom: 2 }}>Rider</div>
                    <div>{r.rider_name}</div>
                    {r.rider_phone ? <PhoneLink phone={r.rider_phone} style={{ fontSize: 12.5 }} /> : null}
                    <div style={{ color: "#666", fontSize: 11.5, textTransform: "uppercase", marginTop: 8, marginBottom: 2 }}>Driver</div>
                    <div>{r.driver_name || "Unassigned"}</div>
                    {r.driver_phone ? <PhoneLink phone={r.driver_phone} style={{ fontSize: 12.5 }} /> : null}
                    {r.make_model ? <div style={{ color: "#666", fontSize: 12, marginTop: 2 }}>{r.make_model} · {r.plate_number}</div> : null}
                    {r.location_updated_at ? (
                      <div style={{ color: "#999", fontSize: 11, marginTop: 8 }}>Position updated {timeAgo(r.location_updated_at)}</div>
                    ) : null}
                  </div>
                </Popup>
              </Marker>
            ))}
          </MapContainer>
        </div>
      )}

      {withoutLocation.length > 0 ? (
        <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 10 }}>
          {withoutLocation.length} ride{withoutLocation.length > 1 ? "s are" : " is"} in progress but the driver hasn't reported a GPS position yet, so {withoutLocation.length > 1 ? "they don't" : "it doesn't"} appear on the map above.
        </p>
      ) : null}
    </div>
  );
}
