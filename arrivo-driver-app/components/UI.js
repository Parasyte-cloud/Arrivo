import React from "react";
import { View, Text, Pressable, StyleSheet, Platform } from "react-native";
import { BlurView } from "expo-blur";
import { Ionicons } from "@expo/vector-icons";
import { colors, radius, spacing, tint, isDark } from "../theme/tokens";

// Plain, website-style building blocks: flat white cards with a thin border,
// one amber primary button, one outlined secondary button. No blur, no gloss.
// `tone` is still accepted so every existing screen keeps working.
export function Card({ children, style, tinted }) {
  return (
    <View style={[styles.card, tinted && styles.cardTinted, style]}>
      {/* Liquid glass: a real blur behind a translucent fill, with a bright top edge like the website. */}
      {Platform.OS === "web" ? null : <BlurView pointerEvents="none" intensity={isDark ? 30 : 40} tint={colors.blurTint} style={StyleSheet.absoluteFill} />}
      <View pointerEvents="none" style={styles.shine} />
      {children}
    </View>
  );
}

export function Button({ label, onPress, variant = "primary", style, disabled, trailingIcon = false }) {
  const isPrimary = variant === "primary";
  const isTeal = variant === "teal";
  // Amber and the website blue both carry fixed text so they read in light and dark.
  const textColor = isTeal ? (isDark ? "#06142a" : "#fff") : "#0a1b33";

  if (variant === "ghost") {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        onPress={onPress}
        disabled={disabled}
        style={({ pressed }) => [styles.ghost, style, (pressed || disabled) && { opacity: 0.6 }]}
      >
        <Text style={[styles.btnText, { color: colors.ink }]}>{label}</Text>
      </Pressable>
    );
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.btnBase,
        isTeal ? styles.btnTeal : styles.btnPrimary,
        style,
        (pressed || disabled) && { opacity: 0.6 },
      ]}
    >
      <Text style={[styles.btnText, { color: textColor }, trailingIcon && { marginRight: 30 }]}>{label}</Text>
      {trailingIcon ? (
        <View style={styles.btnArrowBadge}>
          <Ionicons name="arrow-forward" size={14} color={textColor} />
        </View>
      ) : null}
    </Pressable>
  );
}

export function Field({ icon, placeholder, value, onChangeText, editable = true }) {
  return (
    <View style={styles.field}>
      {icon}
      <Text style={styles.fieldText}>{value || placeholder}</Text>
    </View>
  );
}

export function Tag({ label, tone = "teal" }) {
  const bg = tone === "teal" ? "rgba(46,76,140,0.14)" : "rgba(244,163,0,0.16)";
  const fg = tone === "teal" ? colors.inkSoft : colors.amber;
  return (
    <View style={[styles.tag, { backgroundColor: bg }]}>
      <Text style={{ color: fg, fontSize: 10, fontWeight: "700" }}>{label}</Text>
    </View>
  );
}

// Circular icon chip, matching the reference design's icon treatment
// (previously screens rendered bare Ionicons with colors.cream directly on
// a light or gradient background, which was often invisible).
// tone="dark" (default): soft white-tinted circle for the navy main-app
// screens. tone="light": soft navy-tinted circle for cream screens.
// tone="amber": solid amber circle for the single most prominent action.
export function IconBadge({ children, tone = "dark", size = 40, style }) {
  const variants = {
    dark: { backgroundColor: tint(0.06), borderColor: tint(0.12) },
    light: { backgroundColor: tint(0.06), borderColor: tint(0.12) },
    amber: { backgroundColor: colors.amber, borderColor: colors.amber },
  };
  return (
    <View
      style={[
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          borderWidth: 1,
          alignItems: "center",
          justifyContent: "center",
        },
        variants[tone] || variants.dark,
        style,
      ]}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.md,
    backgroundColor: colors.glass,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    padding: spacing.md,
    overflow: "hidden",
    shadowColor: "#06142a",
    shadowOpacity: isDark ? 0.4 : 0.08,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 2,
  },
  shine: { position: "absolute", top: 0, left: 12, right: 12, height: 1, backgroundColor: colors.shine },
  cardTinted: {
    backgroundColor: "rgba(244,163,0,0.10)",
    borderColor: "rgba(244,163,0,0.35)",
  },
  ghost: {
    borderRadius: radius.sm + 2,
    borderWidth: 1.5,
    borderColor: tint(0.25),
    backgroundColor: colors.glass,
    paddingVertical: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  field: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: colors.fieldBg,
    borderRadius: radius.sm + 2,
    paddingVertical: 12,
    paddingHorizontal: spacing.md,
  },
  fieldText: { color: colors.textMuted, fontSize: 13 },
  btnBase: {
    paddingVertical: 14,
    borderRadius: radius.sm + 2,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  btnArrowBadge: {
    position: "absolute",
    right: 8,
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: tint(0.16),
    alignItems: "center",
    justifyContent: "center",
  },
  btnPrimary: { backgroundColor: colors.amber },
  btnTeal: { backgroundColor: colors.teal },
  btnText: { fontWeight: "700", fontSize: 14 },
  tag: { alignSelf: "flex-start", paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, marginTop: 4 },
});
