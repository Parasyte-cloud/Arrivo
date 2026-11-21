import React, { useRef, useEffect, useState } from "react";
import { StyleSheet, View, Text } from "react-native";
import MapView, { PROVIDER_GOOGLE, Marker, Polyline } from "react-native-maps";
import Constants from "expo-constants";
import { colors, radius, isDark } from "../theme/tokens";
import { MapPlaceholder } from "./MapPlaceholder";
import { useAuth } from "../context/AuthContext";
import { getRoute } from "../services/api";
import { useT } from "../context/LanguageContext";

// The map for every service (ride, express, campus, chauffeur, removals, air, boat), drawn like ArrivoExpress:
// the road the car will take (not a straight line), a round pickup dot and a square destination pin, the car as it
// moves with a dashed road line to where it is heading, a "34 min · 12.4 km" pill and a Live chip.
// `heading` is "pickup" before the trip starts and "destination" once it is under way.
// With no Google Maps key, or no points yet, MapPlaceholder draws the same picture on a drawn street grid.

// A quiet base map, like Express: no shop and bus-stop clutter, soft land, clear roads. Light and dark follow the phone.
const POI_OFF = [
  { featureType: "poi", stylers: [{ visibility: "off" }] },
  { featureType: "transit", stylers: [{ visibility: "off" }] },
];
const MAP_STYLE_LIGHT = [
  ...POI_OFF,
  { elementType: "geometry", stylers: [{ color: "#eef1f4" }] },
  { featureType: "road", elementType: "geometry", stylers: [{ color: "#ffffff" }] },
  { featureType: "road.arterial", elementType: "geometry", stylers: [{ color: "#f8d98a" }] },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#cfe0ee" }] },
];
const MAP_STYLE_DARK = [
  ...POI_OFF,
  { elementType: "geometry", stylers: [{ color: "#141a33" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#9aa3c0" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#141a33" }] },
  { featureType: "road", elementType: "geometry", stylers: [{ color: "#262e52" }] },
  { featureType: "road.arterial", elementType: "geometry", stylers: [{ color: "#3a3a2a" }] },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#0b1024" }] },
];
const ROUTE_COLOR = isDark ? "#F7F4EC" : "#0B1B2B";

function hasRealMapsKey() {
  const key = Constants.expoConfig?.extra?.googleMapsApiKey;
  return !!key && !key.includes("REPLACE_WITH");
}

const pt = (p) => (p && p.lat != null && p.lng != null && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng)) ? { lat: Number(p.lat), lng: Number(p.lng) } : null);
const toCoord = (p) => ({ latitude: p.lat, longitude: p.lng });
const keyOf = (a, b) => (a && b ? `${a.lat.toFixed(4)},${a.lng.toFixed(4)}>${b.lat.toFixed(4)},${b.lng.toFixed(4)}` : null);

export function formatTrip(durationSeconds, distanceMeters) {
  const parts = [];
  if (Number.isFinite(durationSeconds) && durationSeconds > 0) {
    const m = Math.max(1, Math.round(durationSeconds / 60));
    parts.push(m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`);
  }
  if (Number.isFinite(distanceMeters) && distanceMeters > 0) {
    parts.push(distanceMeters >= 1000 ? `${(distanceMeters / 1000).toFixed(1)} km` : `${Math.round(distanceMeters)} m`);
  }
  return parts.join(" · ");
}

// Asks the backend for the road between two points. A failed or empty answer is not an error: the caller draws a straight line.
function useRoad(a, b, token, minGapMs = 0) {
  const [road, setRoad] = useState(null);
  const lastAt = useRef(0);
  const key = keyOf(a, b);
  useEffect(() => {
    if (!key || !token) { setRoad(null); return undefined; }
    const wait = Math.max(0, lastAt.current + minGapMs - Date.now());
    let cancelled = false;
    const timer = setTimeout(() => {
      lastAt.current = Date.now();
      getRoute(token, a, b)
        .then((r) => { if (!cancelled) setRoad(r && Array.isArray(r.path) && r.path.length > 1 ? r : null); })
        .catch(() => { if (!cancelled) setRoad(null); });
    }, wait);
    return () => { cancelled = true; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, token]);
  return road;
}

export function LiveMap({ pickup, destination, driverLocation, height = 200, etaLabel, distanceLabel, heading = "pickup", live = false, tierLabel }) {
  const { t } = useT();
  const { token } = useAuth();
  const mapRef = useRef(null);
  const p = pt(pickup), d = pt(destination), c = pt(driverLocation);
  const target = heading === "destination" ? d : p;
  const points = [p, d, c].filter(Boolean);

  const road = useRoad(p, d, token);
  const lead = useRoad(c, target, token, 15000);
  const pillText = road ? formatTrip(road.durationSeconds, road.distanceMeters) : [etaLabel, distanceLabel].filter(Boolean).join(" · ");

  const fitKey = [p?.lat, p?.lng, d?.lat, d?.lng, c?.lat, c?.lng, road ? road.path.length : 0].join("|");
  useEffect(() => {
    if (!mapRef.current || points.length === 0) return;
    if (points.length === 1) {
      mapRef.current.animateToRegion({ latitude: points[0].lat, longitude: points[0].lng, latitudeDelta: 0.04, longitudeDelta: 0.04 }, 400);
    } else {
      const all = road ? road.path.concat(points) : points;
      mapRef.current.fitToCoordinates(all.map(toCoord), { edgePadding: { top: 60, right: 40, bottom: 56, left: 40 }, animated: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey]);

  const chips = (
    <View pointerEvents="none" style={styles.chipRow}>
      {live ? <View style={styles.liveChip}><View style={styles.liveDot} /><Text style={styles.liveText}>{t("mapLive")}</Text></View> : null}
      {tierLabel ? <View style={styles.tierChip}><Text style={styles.tierText}>{tierLabel}</Text></View> : null}
    </View>
  );
  const pill = pillText ? (
    <View pointerEvents="none" style={styles.pill}><Text style={styles.pillText}>{pillText}</Text></View>
  ) : null;

  if (!hasRealMapsKey() || points.length === 0) {
    return (
      <View>
        <MapPlaceholder etaLabel={etaLabel} distanceLabel={distanceLabel} height={height} hasRoute={Boolean(p && d)} />
        {chips}
      </View>
    );
  }

  const line = road ? road.path.map(toCoord) : p && d ? [toCoord(p), toCoord(d)] : null;
  const leadLine = lead ? lead.path.map(toCoord) : c && target ? [toCoord(c), toCoord(target)] : null;

  return (
    <View>
      <MapView
        ref={mapRef}
        provider={PROVIDER_GOOGLE}
        style={[styles.map, { height }]}
        customMapStyle={isDark ? MAP_STYLE_DARK : MAP_STYLE_LIGHT}
        toolbarEnabled={false}
        showsCompass={false}
        initialRegion={{ latitude: points[0].lat, longitude: points[0].lng, latitudeDelta: 0.05, longitudeDelta: 0.05 }}
      >
        {line ? <Polyline coordinates={line} strokeColor={ROUTE_COLOR} strokeColors={undefined} strokeWidth={5} lineCap="round" lineJoin="round" /> : null}
        {leadLine ? <Polyline coordinates={leadLine} strokeColor={colors.amber} strokeWidth={4} lineDashPattern={[10, 8]} /> : null}
        {p ? (
          <Marker coordinate={toCoord(p)} anchor={{ x: 0.5, y: 0.5 }} tracksViewChanges={false} title={t("mapPickup")}>
            <View style={styles.dot}><View style={styles.dotCore} /></View>
          </Marker>
        ) : null}
        {d ? (
          <Marker coordinate={toCoord(d)} anchor={{ x: 0.5, y: 0.5 }} tracksViewChanges={false} title={t("mapDestination")}>
            <View style={styles.square}><View style={styles.squareCore} /></View>
          </Marker>
        ) : null}
        {c ? (
          <Marker coordinate={toCoord(c)} title={t("mapYou")} anchor={{ x: 0.5, y: 0.5 }} tracksViewChanges={false}>
            <View style={styles.car}><Text style={styles.carGlyph}>🚗</Text></View>
          </Marker>
        ) : null}
      </MapView>
      {chips}
      {pill}
    </View>
  );
}

const ink = "#0B1B2B";
const styles = StyleSheet.create({
  map: { width: "100%", borderRadius: radius.md, overflow: "hidden" },
  chipRow: { position: "absolute", top: 10, left: 10, right: 10, flexDirection: "row", gap: 8, alignItems: "center" },
  liveChip: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999, backgroundColor: "rgba(255,255,255,0.86)", borderWidth: 1, borderColor: "rgba(255,255,255,0.9)" },
  liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: "#E5484D" },
  liveText: { fontSize: 12, fontWeight: "800", color: "#12123B", letterSpacing: 0.4 },
  tierChip: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999, backgroundColor: "rgba(18,18,59,0.78)" },
  tierText: { fontSize: 12, fontWeight: "700", color: "#fff" },
  pill: { position: "absolute", left: 10, bottom: 10, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, backgroundColor: "rgba(255,255,255,0.92)", shadowColor: "#000", shadowOpacity: 0.18, shadowRadius: 4, shadowOffset: { width: 0, height: 2 }, elevation: 3 },
  pillText: { fontSize: 12, fontWeight: "800", color: ink },
  dot: { width: 22, height: 22, borderRadius: 11, backgroundColor: "#fff", alignItems: "center", justifyContent: "center", borderWidth: 2, borderColor: ink },
  dotCore: { width: 8, height: 8, borderRadius: 4, backgroundColor: ink },
  square: { width: 22, height: 22, borderRadius: 4, backgroundColor: "#fff", alignItems: "center", justifyContent: "center", borderWidth: 2, borderColor: ink },
  squareCore: { width: 8, height: 8, borderRadius: 1, backgroundColor: ink },
  car: { width: 38, height: 38, borderRadius: 19, backgroundColor: "#fff", alignItems: "center", justifyContent: "center", borderWidth: 2, borderColor: colors.amber, shadowColor: "#000", shadowOpacity: 0.25, shadowRadius: 4, shadowOffset: { width: 0, height: 2 }, elevation: 4 },
  carGlyph: { fontSize: 20 },
});
