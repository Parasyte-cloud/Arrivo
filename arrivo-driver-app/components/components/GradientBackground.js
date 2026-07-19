import React from "react";
import { StyleSheet } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { colors } from "../theme/tokens";

// Gives the Liquid Glass blur something real to blur. A flat solid-color
// screen behind a BlurView is visually indistinguishable from no blur at
// all — this gradient (warm amber wash, cream middle, soft navy-tinted
// wash) gives BlurView real tonal variation underneath a card so the
// frosted effect actually reads as glass, without requiring an actual
// photo asset per screen. Deliberately more contrast than a first pass —
// pastel-close colors can still look nearly flat once blurred, since blur
// further softens transitions on top of already-subtle contrast.
export function GradientBackground({ children, style }) {
  return (
    <LinearGradient
      colors={["#F9DFA6", colors.bg, "#D9DEF2"]}
      locations={[0, 0.5, 1]}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={[StyleSheet.absoluteFill, style]}
    >
      {children}
    </LinearGradient>
  );
}
