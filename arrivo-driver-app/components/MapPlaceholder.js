import React from "react";
import { View, Text, StyleSheet } from "react-native";
import Svg, { Path, Rect, Circle, Line } from "react-native-svg";
import { colors, radius, isDark } from "../theme/tokens";

// What the map shows when there is no Google Maps key or no points yet. It is drawn to look like the real one
// (ArrivoExpress style): soft land, a street grid, water, the route as a solid ink line with a round pickup dot
// and a square destination pin, and the "34 min · 12.4 km" pill. LiveMap.js swaps in the real map when it can.
const LAND = isDark ? "#141A33" : "#EEF1F4";
const ROAD = isDark ? "#262E52" : "#FFFFFF";
const MAIN = isDark ? "#3A3A2A" : "#F8D98A";
const WATER = isDark ? "#0B1024" : "#CFE0EE";
const INK = isDark ? "#F7F4EC" : "#0B1B2B";

export function MapPlaceholder({ etaLabel, distanceLabel, height = 170, hasRoute = true }) {
  const pill = [etaLabel, distanceLabel].filter(Boolean).join(" · ");
  return (
    <View style={[styles.wrap, { height }]}>
      <Svg width="100%" height="100%" viewBox="0 0 260 160" preserveAspectRatio="xMidYMid slice" style={StyleSheet.absoluteFill}>
        <Rect x="0" y="0" width="260" height="160" fill={LAND} />
        <Path d="M0,128 C40,118 70,140 120,136 S210,118 260,126 L260,160 L0,160 Z" fill={WATER} />
        {[24, 62, 100].map((y) => <Line key={`h${y}`} x1="0" y1={y} x2="260" y2={y + 6} stroke={ROAD} strokeWidth="5" />)}
        {[30, 84, 138, 192, 238].map((x) => <Line key={`v${x}`} x1={x} y1="0" x2={x - 10} y2="130" stroke={ROAD} strokeWidth="5" />)}
        <Path d="M0,80 C60,70 120,96 170,70 S240,40 260,36" stroke={MAIN} strokeWidth="7" fill="none" strokeLinecap="round" />
        {hasRoute ? (
          <>
            <Path d="M30,104 L84,98 L92,64 L170,70 L192,28 L238,24" stroke={INK} strokeWidth="4.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            <Circle cx="30" cy="104" r="7" fill="#fff" stroke={INK} strokeWidth="2.5" />
            <Circle cx="30" cy="104" r="2.6" fill={INK} />
            <Rect x="231" y="17" width="14" height="14" rx="3" fill="#fff" stroke={INK} strokeWidth="2.5" />
            <Rect x="235.5" y="21.5" width="5" height="5" rx="1" fill={INK} />
          </>
        ) : null}
      </Svg>
      {pill ? (
        <View style={styles.pill}>
          <Text style={styles.pillText}>{pill}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { borderRadius: radius.md, backgroundColor: LAND, overflow: "hidden", position: "relative" },
  pill: { position: "absolute", left: 10, bottom: 10, backgroundColor: "rgba(255,255,255,0.92)", paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999 },
  pillText: { color: "#0B1B2B", fontSize: 12, fontWeight: "800" },
});
