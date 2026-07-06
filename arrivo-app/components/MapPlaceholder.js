import React from "react";
import { View, Text, StyleSheet } from "react-native";
import Svg, { Path, Circle } from "react-native-svg";
import { colors, radius } from "../theme/tokens";

// NOTE: This is a stylized placeholder so the app runs with zero API keys.
// To go live, swap this component's contents for <MapView> from
// react-native-maps, wired to your Google Maps API key (see app.json > extra.googleMapsApiKey).
export function MapPlaceholder({ etaLabel, distanceLabel, height = 170 }) {
  return (
    <View style={[styles.wrap, { height }]}>
      <Svg width="100%" height="100%" viewBox="0 0 260 160" style={StyleSheet.absoluteFill}>
        <Path
          d="M20,130 C70,110 90,60 140,55 S 210,30 240,20"
          stroke={colors.amber}
          strokeWidth="2.5"
          fill="none"
          strokeDasharray="1 8"
          strokeLinecap="round"
        />
        <Circle cx="20" cy="130" r="5" fill={colors.teal} />
        <Circle cx="140" cy="55" r="4" fill={colors.cream} />
        <Circle cx="240" cy="20" r="5" fill={colors.coral} />
      </Svg>
      {etaLabel ? (
        <View style={styles.chip}>
          <Text style={styles.chipText}>{etaLabel}</Text>
        </View>
      ) : null}
      {distanceLabel ? (
        <View style={[styles.chip, styles.chipBottom]}>
          <Text style={styles.chipText}>{distanceLabel}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    borderRadius: radius.md,
    backgroundColor: "#0C0C2E",
    overflow: "hidden",
    position: "relative",
  },
  chip: {
    position: "absolute",
    top: 10,
    right: 10,
    backgroundColor: "rgba(247,244,236,0.95)",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
  },
  chipBottom: { top: undefined, bottom: 10, left: 10, right: undefined },
  chipText: { color: colors.ink, fontSize: 10, fontWeight: "700" },
});
