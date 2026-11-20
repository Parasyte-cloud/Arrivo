import React, { useRef, useEffect } from "react";
import { StyleSheet, View, Text } from "react-native";
import MapView, { PROVIDER_GOOGLE, Marker, Polyline } from "react-native-maps";
import Constants from "expo-constants";
import { colors, radius } from "../theme/tokens";
import { MapPlaceholder } from "./MapPlaceholder";
import { useTranslation } from "react-i18next";

// Real map keys aren't configured until someone fills in app.json's
// extra.googleMapsApiKey / ios.config.googleMapsApiKey /
// android.config.googleMaps.apiKey — until then, keep rendering the
// stylized placeholder rather than showing react-native-maps' broken/blank
// "for development purposes only" tile error. Same "runs with zero API
// keys" philosophy MapPlaceholder.js was originally built around.
function hasRealMapsKey() {
  const key = Constants.expoConfig?.extra?.googleMapsApiKey;
  return !!key && !key.includes("REPLACE_WITH");
}

// pickup/destination/driverLocation: { lat, lng, label? } or null.
// Note: this draws straight-line markers, not an actual road-following
// route polyline — that would need the Directions API wired up
// separately, which isn't part of this version.
// The same map for every service (ride, express, campus, chauffeur, removals, air, boat), like Bolt or Chowdeck:
// the planned route, the car as it moves, a dashed line from the car to where it is heading, and a Live chip.
// `heading` is "pickup" before the trip starts and "destination" once it is under way.
export function LiveMap({ pickup, destination, driverLocation, height = 200, etaLabel, distanceLabel, heading = "pickup", live = false, tierLabel }) {
  const { t } = useTranslation();
  const mapRef = useRef(null);
  const points = [pickup, destination, driverLocation].filter((p) => p && p.lat != null && p.lng != null);

  useEffect(() => {
    if (!mapRef.current || points.length === 0) return;
    if (points.length === 1) {
      mapRef.current.animateToRegion(
        { latitude: points[0].lat, longitude: points[0].lng, latitudeDelta: 0.05, longitudeDelta: 0.05 },
        400
      );
    } else {
      mapRef.current.fitToCoordinates(
        points.map((p) => ({ latitude: p.lat, longitude: p.lng })),
        { edgePadding: { top: 40, right: 40, bottom: 40, left: 40 }, animated: true }
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickup?.lat, pickup?.lng, destination?.lat, destination?.lng, driverLocation?.lat, driverLocation?.lng]);

  const target = heading === "destination" ? destination : pickup;
  const hasLine = pickup?.lat != null && destination?.lat != null;
  const hasLead = driverLocation?.lat != null && target?.lat != null;

  const chips = (
    <View pointerEvents="none" style={styles.chipRow}>
      {live ? (
        <View style={styles.liveChip}><View style={styles.liveDot} /><Text style={styles.liveText}>{t("liveMap.live")}</Text></View>
      ) : null}
      {tierLabel ? <View style={styles.tierChip}><Text style={styles.tierText}>{tierLabel}</Text></View> : null}
    </View>
  );

  if (!hasRealMapsKey() || points.length === 0) {
    return (
      <View>
        <MapPlaceholder etaLabel={etaLabel} distanceLabel={distanceLabel} height={height} />
        {chips}
      </View>
    );
  }

  return (
    <View>
      <MapView
        ref={mapRef}
        provider={PROVIDER_GOOGLE}
        style={[styles.map, { height }]}
        initialRegion={{
          latitude: points[0].lat,
          longitude: points[0].lng,
          latitudeDelta: 0.05,
          longitudeDelta: 0.05,
        }}
      >
        {hasLine ? (
          <Polyline
            coordinates={[{ latitude: pickup.lat, longitude: pickup.lng }, { latitude: destination.lat, longitude: destination.lng }]}
            strokeColor={colors.teal}
            strokeWidth={4}
          />
        ) : null}
        {hasLead ? (
          <Polyline
            coordinates={[{ latitude: driverLocation.lat, longitude: driverLocation.lng }, { latitude: target.lat, longitude: target.lng }]}
            strokeColor={colors.amber}
            strokeWidth={3}
            lineDashPattern={[8, 8]}
          />
        ) : null}
        {pickup?.lat != null ? (
          <Marker coordinate={{ latitude: pickup.lat, longitude: pickup.lng }} title={t("liveMap.pickup")} pinColor={colors.teal} />
        ) : null}
        {destination?.lat != null ? (
          <Marker coordinate={{ latitude: destination.lat, longitude: destination.lng }} title={t("liveMap.destination")} pinColor={colors.coral} />
        ) : null}
        {driverLocation?.lat != null ? (
          <Marker coordinate={{ latitude: driverLocation.lat, longitude: driverLocation.lng }} title={t("liveMap.yourDriver")} anchor={{ x: 0.5, y: 0.5 }} tracksViewChanges={false}>
            <View style={styles.car}><Text style={styles.carGlyph}>🚗</Text></View>
          </Marker>
        ) : null}
      </MapView>
      {chips}
    </View>
  );
}

const styles = StyleSheet.create({
  map: { width: "100%", borderRadius: radius.md, overflow: "hidden" },
  chipRow: { position: "absolute", top: 10, left: 10, right: 10, flexDirection: "row", gap: 8, alignItems: "center" },
  liveChip: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999, backgroundColor: "rgba(255,255,255,0.78)", borderWidth: 1, borderColor: "rgba(255,255,255,0.9)" },
  liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: "#E5484D" },
  liveText: { fontSize: 12, fontWeight: "800", color: "#12123B", letterSpacing: 0.4 },
  tierChip: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999, backgroundColor: "rgba(18,18,59,0.72)" },
  tierText: { fontSize: 12, fontWeight: "700", color: "#fff" },
  car: { width: 38, height: 38, borderRadius: 19, backgroundColor: "#fff", alignItems: "center", justifyContent: "center", borderWidth: 2, borderColor: colors.amber, shadowColor: "#000", shadowOpacity: 0.25, shadowRadius: 4, shadowOffset: { width: 0, height: 2 }, elevation: 4 },
  carGlyph: { fontSize: 20 },
});
