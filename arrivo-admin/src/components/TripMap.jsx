import { useEffect, useRef, useState } from "react";
import { MapContainer, TileLayer, Marker, Polyline, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { googleMapsKey, loadGoogleMaps } from "../lib/googleMaps";

const LAGOS = { lat: 6.5244, lng: 3.3792 };

export function tripColor(trip) {
  if (trip.has_active_panic) return "#ff6b57";
  switch (trip.ride_status) {
    case "in_progress": return "#4fd9c7";
    case "accepted": return "#f4a300";
    case "completed": return "#8b8fa8";
    default: return "#8aa0ff";
  }
}

// Material "flight" glyph, nose pointing up, so rotation = compass heading.
export const PLANE_PATH = "M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5z";

const hasPos = (lat, lng) => typeof lat === "number" && typeof lng === "number";

function distanceM(a, b) {
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

function bearing(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function pointsOf(trip) {
  return {
    driver: hasPos(trip.current_lat, trip.current_lng) ? { lat: trip.current_lat, lng: trip.current_lng } : null,
    pickup: hasPos(trip.pickup_lat, trip.pickup_lng) ? { lat: trip.pickup_lat, lng: trip.pickup_lng } : null,
    dest: hasPos(trip.destination_lat, trip.destination_lng) ? { lat: trip.destination_lat, lng: trip.destination_lng } : null,
  };
}

// Google's "night" look so the map sits with the dark Console theme.
export const DARK_STYLE = [
  { elementType: "geometry", stylers: [{ color: "#1d2040" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#9aa0c8" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#12123b" }] },
  { featureType: "road", elementType: "geometry", stylers: [{ color: "#2c3160" }] },
  { featureType: "road.highway", elementType: "geometry", stylers: [{ color: "#3b4180" }] },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#0b0d2a" }] },
  { featureType: "poi", stylers: [{ visibility: "off" }] },
  { featureType: "transit", stylers: [{ visibility: "off" }] },
];

function animateTo(marker, to, ms = 900) {
  const from = marker.getPosition();
  if (!from) { marker.setPosition(to); return; }
  const a = { lat: from.lat(), lng: from.lng() };
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / ms);
    marker.setPosition({ lat: a.lat + (to.lat - a.lat) * t, lng: a.lng + (to.lng - a.lng) * t });
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function GoogleTripMap({ trips, selectedId, onSelect, onRoute, onFail, plane }) {
  const box = useRef(null);
  const mapRef = useRef(null);
  const mapsRef = useRef(null);
  const markers = useRef(new Map()); // key -> { marker, last, heading }
  const extras = useRef({ pickup: null, dest: null, renderer: null, fallback: null });
  const routeState = useRef({ key: "", at: 0, from: null });
  const fittedFor = useRef(null);
  const planeMarker = useRef(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let dead = false;
    loadGoogleMaps()
      .then((maps) => {
        if (dead || !box.current) return;
        mapsRef.current = maps;
        mapRef.current = new maps.Map(box.current, {
          center: LAGOS,
          zoom: 11,
          styles: DARK_STYLE,
          disableDefaultUI: true,
          zoomControl: true,
          fullscreenControl: true,
          gestureHandling: "greedy",
        });
        setReady(true);
      })
      .catch((e) => { if (!dead) onFail(e.message); });
    return () => {
      dead = true;
      markers.current.forEach(({ marker }) => marker.setMap(null));
      markers.current.clear();
      const x = extras.current;
      [x.pickup, x.dest, x.fallback].forEach((m) => m && m.setMap(null));
      if (x.renderer) x.renderer.setMap(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Driver markers (smoothly moving) and small pins for rides still waiting at a pickup.
  useEffect(() => {
    if (!ready) return;
    const maps = mapsRef.current;
    const map = mapRef.current;
    const seen = new Set();
    for (const trip of trips) {
      const { driver, pickup } = pointsOf(trip);
      const selected = trip.id === selectedId;
      const color = tripColor(trip);
      if (driver) {
        const key = `d${trip.id}`;
        seen.add(key);
        let entry = markers.current.get(key);
        if (!entry) {
          const marker = new maps.Marker({ map, position: driver, zIndex: 20 });
          marker.addListener("click", () => onSelect(trip.id));
          entry = { marker, last: driver, heading: 0 };
          markers.current.set(key, entry);
        } else if (distanceM(entry.last, driver) > 15) {
          entry.heading = bearing(entry.last, driver);
          entry.last = driver;
          animateTo(entry.marker, driver);
        }
        entry.marker.setIcon({
          path: maps.SymbolPath.FORWARD_CLOSED_ARROW,
          scale: selected ? 7 : 5,
          rotation: entry.heading,
          fillColor: color,
          fillOpacity: 1,
          strokeColor: "#ffffff",
          strokeWeight: selected ? 2.5 : 1.5,
        });
        entry.marker.setZIndex(selected ? 40 : 20);
        entry.marker.setTitle(`Ride #${trip.id}`);
      } else if (pickup && trip.ride_status === "requested") {
        const key = `p${trip.id}`;
        seen.add(key);
        let entry = markers.current.get(key);
        if (!entry) {
          const marker = new maps.Marker({ map, position: pickup, zIndex: 10 });
          marker.addListener("click", () => onSelect(trip.id));
          entry = { marker, last: pickup, heading: 0 };
          markers.current.set(key, entry);
        }
        entry.marker.setIcon({
          path: maps.SymbolPath.CIRCLE, scale: selected ? 9 : 6, fillColor: color, fillOpacity: 0.9,
          strokeColor: "#ffffff", strokeWeight: 1.5,
        });
        entry.marker.setTitle(`Waiting: ride #${trip.id}`);
      }
    }
    markers.current.forEach((entry, key) => {
      if (!seen.has(key)) { entry.marker.setMap(null); markers.current.delete(key); }
    });

    // First time there is something to show, frame everything.
    if (!selectedId && fittedFor.current !== "all" && markers.current.size > 0) {
      const bounds = new maps.LatLngBounds();
      markers.current.forEach(({ last }) => bounds.extend(last));
      map.fitBounds(bounds, 80);
      if (map.getZoom() > 15) map.setZoom(15);
      fittedFor.current = "all";
    }
  }, [ready, trips, selectedId, onSelect]);

  // The selected trip: pickup and destination pins, the route line, and ETA numbers.
  useEffect(() => {
    if (!ready) return;
    const maps = mapsRef.current;
    const map = mapRef.current;
    const x = extras.current;
    const clear = () => {
      [x.pickup, x.dest, x.fallback].forEach((m) => m && m.setMap(null));
      x.pickup = x.dest = x.fallback = null;
      if (x.renderer) x.renderer.setMap(null);
      x.renderer = null;
    };

    const trip = trips.find((t) => t.id === selectedId);
    if (!trip) { clear(); onRoute(null); routeState.current = { key: "", at: 0, from: null }; return; }
    const { driver, pickup, dest } = pointsOf(trip);

    const pin = (pos, text, fill) => new maps.Marker({
      map, position: pos, zIndex: 30,
      icon: { path: maps.SymbolPath.CIRCLE, scale: 11, fillColor: fill, fillOpacity: 1, strokeColor: "#fff", strokeWeight: 2 },
      label: { text, color: "#0d0d2e", fontWeight: "700", fontSize: "12px" },
    });
    if (x.pickup) x.pickup.setMap(null);
    if (x.dest) x.dest.setMap(null);
    x.pickup = pickup ? pin(pickup, "P", "#4fd9c7") : null;
    x.dest = dest ? pin(dest, "D", "#f4a300") : null;

    const phase = trip.ride_status === "in_progress" ? "trip" : trip.ride_status === "accepted" ? "pickup" : "plan";
    const origin = phase === "plan" ? pickup : (driver || pickup);
    const key = `${trip.id}:${phase}`;
    const moved = routeState.current.from && origin ? distanceM(routeState.current.from, origin) : Infinity;
    const stale = Date.now() - routeState.current.at > 90000;
    const changed = routeState.current.key !== key;
    const fitNeeded = fittedFor.current !== `t${trip.id}`;

    if (fitNeeded) {
      const bounds = new maps.LatLngBounds();
      [driver, pickup, dest].filter(Boolean).forEach((p) => bounds.extend(p));
      if (!bounds.isEmpty()) { map.fitBounds(bounds, 90); if (map.getZoom() > 16) map.setZoom(16); }
      fittedFor.current = `t${trip.id}`;
    }

    if (!origin || !(dest || (phase === "pickup" && pickup)) || (!changed && !(stale && moved > 250))) return;
    routeState.current = { key, at: Date.now(), from: origin };

    const target = phase === "pickup" && !dest ? pickup : dest;
    const stops = phase === "pickup" && pickup && dest ? [pickup] : [];
    const ticket = routeState.current.at;
    const fmtTime = (ms) => {
      const m = Math.max(1, Math.round(ms / 60000));
      return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
    };
    const fmtDist = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);
    const clearLines = () => {
      (x.lines || []).forEach((l) => l.setMap(null));
      x.lines = [];
      if (x.renderer) { x.renderer.setMap(null); x.renderer = null; }
      if (x.fallback) { x.fallback.setMap(null); x.fallback = null; }
    };
    const drawFallback = (why) => {
      clearLines();
      const path = [driver, pickup, dest].filter(Boolean);
      x.fallback = new maps.Polyline({
        map, path, strokeOpacity: 0,
        icons: [{ icon: { path: "M 0,-1 0,1", strokeOpacity: 1, scale: 3, strokeColor: "#f4a300" }, offset: "0", repeat: "14px" }],
      });
      onRoute({ phase, error: why });
    };
    const report = (legs) => {
      const leg = (l) => l && { text: fmtTime(l.seconds * 1000), seconds: l.seconds, distance: fmtDist(l.meters) };
      onRoute({
        phase,
        toPickup: phase === "pickup" ? leg(legs[0]) : null,
        toDestination: phase === "pickup" ? leg(legs[1]) : leg(legs[0]),
      });
    };

    // Routes API first (what new Google projects have), the older Directions service as a fallback.
    (async () => {
      try {
        const { Route } = await maps.importLibrary("routes");
        const { routes } = await Route.computeRoutes({
          origin, destination: target, intermediates: stops,
          travelMode: "DRIVING", routingPreference: "TRAFFIC_AWARE", departureTime: new Date(),
          fields: ["path", "legs", "durationMillis", "distanceMeters"],
        });
        if (routeState.current.at !== ticket || !routes?.[0]) return;
        clearLines();
        x.lines = routes[0].createPolylines({ polylineOptions: { map, strokeColor: "#f4a300", strokeWeight: 5, strokeOpacity: 0.9 } });
        report(routes[0].legs.map((l) => ({ seconds: (l.durationMillis || 0) / 1000, meters: l.distanceMeters || 0 })));
        return;
      } catch (e) {
        if (routeState.current.at !== ticket) return;
        if (!maps.DirectionsService) { drawFallback("Route lines need the Routes API enabled on the Google project."); return; }
      }
      new maps.DirectionsService().route({
        origin, destination: target, travelMode: maps.TravelMode.DRIVING,
        drivingOptions: { departureTime: new Date(), trafficModel: "bestguess" },
        ...(stops.length ? { waypoints: stops.map((location) => ({ location, stopover: true })) } : {}),
      }, (result, status) => {
        if (routeState.current.at !== ticket) return;
        if (status === "OK" && result) {
          clearLines();
          x.renderer = new maps.DirectionsRenderer({
            map, suppressMarkers: true, preserveViewport: true,
            polylineOptions: { strokeColor: "#f4a300", strokeWeight: 5, strokeOpacity: 0.9 },
          });
          x.renderer.setDirections(result);
          report(result.routes[0].legs.map((l) => ({ seconds: (l.duration_in_traffic || l.duration).value, meters: l.distance.value })));
        } else {
          drawFallback("Route lines need the Routes API enabled on the Google project.");
        }
      });
    })();
  }, [ready, trips, selectedId, onRoute]);

  // The flight, when the provider gives a live position (FlightAware).
  useEffect(() => {
    const maps = mapsRef.current;
    const map = mapRef.current;
    if (!ready || !maps || !map) return;
    if (!plane || typeof plane.lat !== "number" || typeof plane.lng !== "number") {
      if (planeMarker.current) { planeMarker.current.setMap(null); planeMarker.current = null; }
      return;
    }
    const icon = {
      path: PLANE_PATH, fillColor: "#ffffff", fillOpacity: 1, strokeColor: "#0d0d2e", strokeWeight: 1,
      scale: 1.6, rotation: plane.heading || 0, anchor: new maps.Point(12, 12),
    };
    if (!planeMarker.current) {
      planeMarker.current = new maps.Marker({ map, position: plane, icon, zIndex: 900, title: "Flight" });
    } else {
      planeMarker.current.setPosition(plane);
      planeMarker.current.setIcon(icon);
    }
  }, [ready, plane]);

  return <div ref={box} className="tt-map-canvas" />;
}

const dotIcon = (color, size = 16, ring = false) =>
  L.divIcon({
    className: "tt-dot",
    html: `<span style="display:block;width:${size}px;height:${size}px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:0 0 0 ${ring ? 4 : 0}px ${color}55"></span>`,
    iconSize: [size + 4, size + 4],
    iconAnchor: [(size + 4) / 2, (size + 4) / 2],
  });

function FitTo({ points, token }) {
  const map = useMap();
  useEffect(() => {
    if (points.length === 0) return;
    if (points.length === 1) map.setView(points[0], 14);
    else map.fitBounds(points, { padding: [60, 60], maxZoom: 15 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);
  return null;
}

function LeafletTripMap({ trips, selectedId, onSelect, onRoute, plane }) {
  useEffect(() => { onRoute(null); }, [selectedId, onRoute]);
  const selected = trips.find((t) => t.id === selectedId);
  const sel = selected ? pointsOf(selected) : null;
  const line = sel ? [sel.driver, sel.pickup, sel.dest].filter(Boolean).map((p) => [p.lat, p.lng]) : [];
  const framePoints = selected
    ? line
    : trips.map((t) => pointsOf(t)).flatMap((p) => [p.driver || p.pickup]).filter(Boolean).map((p) => [p.lat, p.lng]);
  const frameKey = selected ? `t${selected.id}` : framePoints.length ? "all" : "none";
  return (
    <MapContainer center={[LAGOS.lat, LAGOS.lng]} zoom={11} className="tt-map-canvas">
      <TileLayer attribution='&copy; OpenStreetMap contributors' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
      <FitTo points={framePoints} token={frameKey} />
      {trips.map((t) => {
        const { driver, pickup } = pointsOf(t);
        const pos = driver || (t.ride_status === "requested" ? pickup : null);
        if (!pos) return null;
        return (
          <Marker key={t.id} position={[pos.lat, pos.lng]} icon={dotIcon(tripColor(t), t.id === selectedId ? 20 : 14, t.id === selectedId)}
            eventHandlers={{ click: () => onSelect(t.id) }} />
        );
      })}
      {plane && typeof plane.lat === "number" ? (
        <Marker position={[plane.lat, plane.lng]} icon={L.divIcon({
          className: "tt-dot",
          html: `<span style="display:block;font-size:24px;line-height:24px;color:#fff;text-shadow:0 0 3px #0d0d2e;transform:rotate(${(plane.heading || 0) - 90}deg)">✈</span>`,
          iconSize: [26, 26], iconAnchor: [13, 13],
        })} />
      ) : null}
      {sel?.pickup ? <Marker position={[sel.pickup.lat, sel.pickup.lng]} icon={dotIcon("#4fd9c7", 18)} /> : null}
      {sel?.dest ? <Marker position={[sel.dest.lat, sel.dest.lng]} icon={dotIcon("#f4a300", 18)} /> : null}
      {line.length > 1 ? <Polyline positions={line} pathOptions={{ color: "#f4a300", weight: 4, dashArray: "8 8" }} /> : null}
    </MapContainer>
  );
}

export function TripMap({ trips, selectedId, onSelect, onRoute, onMode, plane = null }) {
  const [failed, setFailed] = useState(!googleMapsKey);
  const [reason, setReason] = useState(googleMapsKey ? "" : "No Google Maps key is set, so this is the basic map.");

  useEffect(() => {
    const onAuth = () => { setFailed(true); setReason("Google Maps rejected the key, so this is the basic map."); };
    window.addEventListener("ra-gm-auth-failure", onAuth);
    return () => window.removeEventListener("ra-gm-auth-failure", onAuth);
  }, []);

  useEffect(() => { onMode(failed ? { mode: "basic", reason } : { mode: "google", reason: "" }); }, [failed, reason, onMode]);

  if (failed) return <LeafletTripMap trips={trips} selectedId={selectedId} onSelect={onSelect} onRoute={onRoute} plane={plane} />;
  return (
    <GoogleTripMap
      trips={trips}
      selectedId={selectedId}
      onSelect={onSelect}
      onRoute={onRoute}
      plane={plane}
      onFail={(msg) => { setFailed(true); setReason(msg); }}
    />
  );
}
