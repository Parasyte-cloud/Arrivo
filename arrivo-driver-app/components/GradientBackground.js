import React from "react";
import { View, StyleSheet } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { colors } from "../theme/tokens";

// Gives the Liquid Glass blur something real to blur. A flat solid-color
// screen behind a BlurView is visually indistinguishable from no blur at
// all — real frosted glass only reads as "glass" when there's actual
// tonal variation behind it to soften.
//
// variant="light" (default): the cream/amber/navy wash used on Login and
// Signup, matching the website's marketing pages.
//
// variant="dark": the rich navy "Liquid Glass" backdrop used on every
// main (post-login) screen — a deep navy gradient plus soft amber/blue
// glow blobs, so cards genuinely blur into a moody, textured background
// instead of a flat panel.
export function GradientBackground({ children, style, variant = "light" }) {
  if (variant === "dark") {
    return (
      <View style={[StyleSheet.absoluteFill, styles.darkBase, style]}>
        <LinearGradient
          colors={[colors.dark.bg1, colors.dark.bg0, "#050514"]}
          locations={[0, 0.55, 1]}
          start={{ x: 0.15, y: 0 }}
          end={{ x: 0.85, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
        <GlowBlob color={colors.dark.glow} size={320} style={{ top: -90, right: -100 }} />
        <GlowBlob color={colors.dark.glow2} size={280} style={{ bottom: -60, left: -90 }} />
        {children}
      </View>
    );
  }

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

// Soft, off-canvas colored blobs, faded via LinearGradient rather than a
// flat fill so they read as a diffuse glow instead of a hard-edged circle.
function GlowBlob({ color, size, style }) {
  return (
    <View
      pointerEvents="none"
      style={[
        { position: "absolute", width: size, height: size, borderRadius: size / 2, overflow: "hidden" },
        style,
      ]}
    >
      <LinearGradient
        colors={[color, "transparent"]}
        start={{ x: 0.3, y: 0.3 }}
        end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  darkBase: { backgroundColor: colors.dark.bg0, overflow: "hidden" },
});
