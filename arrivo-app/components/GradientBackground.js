import React from "react";
import { StyleSheet } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { colors } from "../theme/tokens";

// Gives the Liquid Glass blur something real to blur. A flat solid-color
// screen behind a BlurView is visually indistinguishable from no blur at
// all — this soft, low-contrast gradient (cream base with faint amber and
// navy washes, echoing the website's photo/glass sections) gives BlurView
// enough tonal variation underneath a card for the frosted effect to
// actually read as glass, without competing with foreground content or
// requiring an actual photo asset per screen.
export function GradientBackground({ children, style }) {
  return (
    <LinearGradient
      colors={["#FBEFD9", colors.bg, "#EFEAF6"]}
      locations={[0, 0.5, 1]}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={[StyleSheet.absoluteFill, style]}
    >
      {children}
    </LinearGradient>
  );
}
