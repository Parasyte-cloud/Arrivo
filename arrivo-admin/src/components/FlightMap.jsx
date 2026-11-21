import { useEffect, useMemo, useRef, useState } from "react";
import { MapContainer, TileLayer, Marker, Polyline, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { googleMapsKey, loadGoogleMaps } from "../lib/googleMaps";
import { DARK_STYLE, PLANE_PATH } from "./TripMap";

// A flight-tracking map in the style of the airline trackers: the flown path as a solid line, the
// rest of the route dashed to the airport, the aircraft rotated to its heading, and a small label
// with the flight number, type, status, route and expected arrival.

const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

// Points along the great circle between two coordinates, [lat, lng] pairs.
export function greatCircle(a, b, steps = 48) {
  const [lat1, lon1, lat2, lon2] = [rad(a[0]), rad(a[1]), rad(b[0]), rad(b[1])];
  const d = 2 * Math.asin(Math.sqrt(
    Math.sin((lat2 - lat1) / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin((lon2 - lon1) / 2) ** 2,
  ));
  if (!d) return [a, b];
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    const A = Math.sin((1 - f) * d) / Math.sin(d);
    const B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(lat1) * Math.cos(lon1) + B * Math.cos(lat2) * Math.cos(lon2);
    const y = A * Math.cos(lat1) * Math.sin(lon1) + B * Math.cos(lat2) * Math.sin(lon2);
    const z = A * Math.sin(lat1) + B * Math.sin(lat2);
    out.push([deg(Math.atan2(z, Math.sqrt(x * x + y * y))), deg(Math.atan2(y, x))]);
  }
  return out;
}

const lagosTime = (iso) =>
  iso ? new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Africa/Lagos" }) : null;

// Everything the map needs, in one place, so both map engines draw the same thing.
export function flightGeometry(flight) {
  const pos = flight?.position && typeof flight.position.lat === "number" ? [flight.position.lat, flight.position.lng] : null;
  const track = Array.isArray(flight?.track) && flight.track.length > 1 ? flight.track : null;
  const dest = flight?.destination ? [flight.destination.lat, flight.destination.lng] : null;
  const origin = flight?.origin ? [flight.origin.lat, flight.origin.lng] : track ? track[0] : null;
  const flown = track || (origin && pos ? greatCircle(origin, pos, 24) : null);
  const ahead = pos && dest ? greatCircle(pos, dest, 48) : null;
  const eta = lagosTime(flight?.arrival?.estimated || flight?.arrival?.scheduled);
  const route = [flight?.origin?.code, flight?.destination?.code].filter(Boolean).join(" ");
  const label = {
    top: [flight?.flightNumber, flight?.aircraft].filter(Boolean).join(" "),
    status: flight?.arrival?.estimated ? "ESTIMATED" : String(flight?.status || "").toUpperCase(),
    route: [route, eta].filter(Boolean).join(" "),
  };
  return { pos, track, dest, origin, flown, ahead, label, heading: flight?.position?.heading || 0 };
}

function GoogleFlightMap({ flight, onFail }) {
  const box = useRef(null);
  const state = useRef({});
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let dead = false;
    loadGoogleMaps()
      .then((maps) => {
        if (dead || !box.current) return;
        state.current.maps = maps;
        state.current.map = new maps.Map(box.current, {
          center: { lat: 10, lng: 15 }, zoom: 4, styles: DARK_STYLE, disableDefaultUI: true,
          zoomControl: true, fullscreenControl: true, gestureHandling: "greedy",
        });
        setReady(true);
      })
      .catch((e) => { if (!dead) onFail(e.message); });
    return () => { dead = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const g = useMemo(() => flightGeometry(flight), [flight]);

  useEffect(() => {
    if (!ready) return;
    const { maps, map } = state.current;
    const s = state.current;
    ["flown", "ahead", "plane", "from", "to", "tag"].forEach((k) => { if (s[k]) { s[k].setMap(null); s[k] = null; } });
    const ll = ([lat, lng]) => ({ lat, lng });

    if (g.flown) s.flown = new maps.Polyline({ map, path: g.flown.map(ll), geodesic: true, strokeColor: "#ffffff", strokeOpacity: 0.95, strokeWeight: 2 });
    if (g.ahead) {
      s.ahead = new maps.Polyline({
        map, path: g.ahead.map(ll), geodesic: true, strokeOpacity: 0,
        icons: [{ icon: { path: "M 0,-1 0,1", strokeOpacity: 0.9, strokeColor: "#ffffff", scale: 2 }, offset: "0", repeat: "10px" }],
      });
    }
    const dot = (p, color) => new maps.Marker({
      map, position: ll(p), clickable: false,
      icon: { path: maps.SymbolPath.CIRCLE, scale: 5, fillColor: color, fillOpacity: 1, strokeColor: "#0d0d2e", strokeWeight: 1.5 },
    });
    if (g.origin) s.from = dot(g.origin, "#ffffff");
    if (g.dest) s.to = dot(g.dest, "#f4a300");
    if (g.pos) {
      s.plane = new maps.Marker({
        map, position: ll(g.pos), zIndex: 900, title: g.label.top,
        icon: { path: PLANE_PATH, fillColor: "#ffffff", fillOpacity: 1, strokeColor: "#0d0d2e", strokeWeight: 1, scale: 1.9, rotation: g.heading, anchor: new maps.Point(12, 12) },
      });
      // A small text tag beside the aircraft.
      class Tag extends maps.OverlayView {
        onAdd() {
          this.div = document.createElement("div");
          this.div.className = "fm-tag";
          this.div.innerHTML = `<b></b><span></span><span></span>`;
          const [a, b, c] = this.div.children;
          a.textContent = g.label.top; b.textContent = g.label.status; c.textContent = g.label.route;
          this.getPanes().floatPane.appendChild(this.div);
        }
        draw() {
          const pt = this.getProjection()?.fromLatLngToDivPixel(new maps.LatLng(g.pos[0], g.pos[1]));
          if (pt && this.div) { this.div.style.left = `${pt.x + 18}px`; this.div.style.top = `${pt.y - 22}px`; }
        }
        onRemove() { this.div?.remove(); this.div = null; }
      }
      s.tag = new Tag();
      s.tag.setMap(map);
    }
    const bounds = new maps.LatLngBounds();
    [g.origin, g.pos, g.dest].filter(Boolean).forEach((p) => bounds.extend(ll(p)));
    if (!bounds.isEmpty()) map.fitBounds(bounds, 70);
  }, [ready, g]);

  return <div ref={box} className="tt-map-canvas" />;
}

const planeIcon = (heading) => L.divIcon({
  className: "tt-dot",
  html: `<span style="display:block;font-size:30px;line-height:30px;color:#fff;text-shadow:0 0 4px #0d0d2e;transform:rotate(${heading - 90}deg)">✈</span>`,
  iconSize: [32, 32], iconAnchor: [16, 16],
});
const dotIcon = (color) => L.divIcon({
  className: "tt-dot",
  html: `<span style="display:block;width:12px;height:12px;border-radius:50%;background:${color};border:2px solid #0d0d2e"></span>`,
  iconSize: [16, 16], iconAnchor: [8, 8],
});

function Fit({ points }) {
  const map = useMap();
  useEffect(() => { if (points.length > 1) map.fitBounds(points, { padding: [60, 60] }); else if (points.length === 1) map.setView(points[0], 6); }, [map, points]);
  return null;
}

function LeafletFlightMap({ flight }) {
  const g = useMemo(() => flightGeometry(flight), [flight]);
  const points = [g.origin, g.pos, g.dest].filter(Boolean);
  const tagIcon = L.divIcon({
    className: "tt-dot",
    html: `<div class="fm-tag static"><b>${g.label.top}</b><span>${g.label.status}</span><span>${g.label.route}</span></div>`,
    iconSize: [0, 0], iconAnchor: [-20, 20],
  });
  return (
    <MapContainer center={[10, 15]} zoom={4} className="tt-map-canvas" worldCopyJump>
      <TileLayer
        attribution='&copy; OpenStreetMap contributors &copy; CARTO'
        url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
      />
      {g.flown ? <Polyline positions={g.flown} pathOptions={{ color: "#fff", weight: 2, opacity: 0.95 }} /> : null}
      {g.ahead ? <Polyline positions={g.ahead} pathOptions={{ color: "#fff", weight: 2, opacity: 0.9, dashArray: "6 8" }} /> : null}
      {g.origin ? <Marker position={g.origin} icon={dotIcon("#fff")} /> : null}
      {g.dest ? <Marker position={g.dest} icon={dotIcon("#f4a300")} /> : null}
      {g.pos ? <Marker position={g.pos} icon={planeIcon(g.heading)} zIndexOffset={900} /> : null}
      {g.pos ? <Marker position={g.pos} icon={tagIcon} interactive={false} /> : null}
      <Fit points={points} />
    </MapContainer>
  );
}

export function FlightMap({ flight }) {
  const [failed, setFailed] = useState(!googleMapsKey);
  useEffect(() => {
    const onAuth = () => setFailed(true);
    window.addEventListener("ra-gm-auth-failure", onAuth);
    return () => window.removeEventListener("ra-gm-auth-failure", onAuth);
  }, []);
  return failed ? <LeafletFlightMap flight={flight} /> : <GoogleFlightMap flight={flight} onFail={() => setFailed(true)} />;
}
