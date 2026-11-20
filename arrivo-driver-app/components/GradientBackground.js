import React from "react";
import { View, StyleSheet } from "react-native";
import { colors } from "../theme/tokens";

// One flat cream page, like the website. The old gradient and glow blobs are
// gone on purpose: the apps open in light mode and stay plain. `variant` is
// still accepted so existing screens keep working unchanged.
export function GradientBackground({ children, style }) {
  return <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.bg }, style]}>{children}</View>;
}
