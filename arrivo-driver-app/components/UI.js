import React from "react";
import { View, Text, Pressable, StyleSheet, Platform } from "react-native";
import { BlurView } from "expo-blur";
import { colors, radius, spacing } from "../theme/tokens";

// Real Liquid Glass — BlurView provides genuine native blur (not just a
// translucent color), matching the actual frosted-glass look used
// throughout the website. Android's blur support varies by OS version, so
// a semi-transparent fallback tint sits behind it either way — on devices
// where the blur renders, it looks glassy; where it doesn't, it still
// looks like a reasonable translucent card rather than a solid block.
export function Card({ children, style, tinted }) {
  return (
    <View style={[styles.cardWrap, style]}>
      <BlurView intensity={65} tint="light" style={StyleSheet.absoluteFill} />
      <View
        style={[
          styles.cardOverlay,
          tinted && { backgroundColor: "rgba(244,163,0,0.14)", borderColor: "rgba(244,163,0,0.3)" },
        ]}
      >
        {children}
      </View>
    </View>
  );
}

export function Button({ label, onPress, variant = "primary", style, disabled }) {
  const isPrimary = variant === "primary";
  const isTeal = variant === "teal";
  const textColor = isPrimary ? colors.ink : isTeal ? "#fff" : colors.ink;

  if (variant === "ghost") {
    return (
      <Pressable
        onPress={onPress}
        disabled={disabled}
        style={({ pressed }) => [styles.ghostWrap, style, (pressed || disabled) && { opacity: 0.7 }]}
      >
        <BlurView intensity={50} tint="light" style={StyleSheet.absoluteFill} />
        <View style={styles.ghostOverlay}>
          <Text style={[styles.btnText, { color: colors.ink }]}>{label}</Text>
        </View>
      </Pressable>
    );
  }

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.btnBase,
        isTeal ? styles.btnTeal : styles.btnPrimary,
        style,
        (pressed || disabled) && { opacity: 0.7 },
      ]}
    >
      <Text style={[styles.btnText, { color: textColor }]}>{label}</Text>
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

const styles = StyleSheet.create({
  cardWrap: {
    borderRadius: radius.md,
    overflow: "hidden", // required for BlurView to respect the rounded corners
    borderWidth: 1,
    borderColor: colors.surfaceBorder,
  },
  cardOverlay: {
    backgroundColor: colors.surface,
    padding: spacing.md,
  },
  ghostWrap: {
    borderRadius: radius.sm + 2,
    overflow: "hidden",
    borderWidth: 1.5,
    borderColor: "rgba(18,18,59,0.25)",
  },
  ghostOverlay: {
    backgroundColor: "rgba(255,255,255,0.3)",
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
  },
  btnPrimary: { backgroundColor: colors.amber },
  btnTeal: { backgroundColor: colors.teal },
  btnText: { fontWeight: "700", fontSize: 14 },
  tag: { alignSelf: "flex-start", paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, marginTop: 4 },
});
