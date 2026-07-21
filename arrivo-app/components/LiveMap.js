import React, { useRef, useEffect } from "react";
import { StyleSheet } from "react-native";
import MapView, { PROVIDER_GOOGLE, Marker } from "react-native-maps";
import Constants from "expo-constants";
import { colors, radius } from "../theme/tokens";
import { MapPlaceholder } from "./MapPlaceholder";

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
export function LiveMap({ pickup, destination, driverLocation, height = 200, etaLabel, distanceLabel }) {
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

  if (!hasRealMapsKey() || points.length === 0) {
    return <MapPlaceholder etaLabel={etaLabel} distanceLabel={distanceLabel} height={height} />;
  }

  return (
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
      {pickup?.lat != null ? (
        <Marker coordinate={{ latitude: pickup.lat, longitude: pickup.lng }} title="Pickup" pinColor={colors.teal} />
      ) : null}
      {destination?.lat != null ? (
        <Marker coordinate={{ latitude: destination.lat, longitude: destination.lng }} title="Destination" pinColor={colors.coral} />
      ) : null}
      {driverLocation?.lat != null ? (
        <Marker coordinate={{ latitude: driverLocation.lat, longitude: driverLocation.lng }} title="Your driver" pinColor={colors.amber} />
      ) : null}
    </MapView>
  );
}

const styles = StyleSheet.create({
  map: { width: "100%", borderRadius: radius.md, overflow: "hidden" },
});
