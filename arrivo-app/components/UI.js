import React from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, radius, spacing } from "../theme/tokens";

// Plain, website-style building blocks: flat white cards with a thin border,
// one amber primary button, one outlined secondary button. No blur, no gloss.
// `tone` is still accepted so every existing screen keeps working.
export function Card({ children, style, tinted }) {
  return (
    <View style={[styles.card, tinted && styles.cardTinted, style]}>
      {children}
    </View>
  );
}

export function Button({ label, onPress, variant = "primary", style, disabled, trailingIcon = false }) {
  const isPrimary = variant === "primary";
  const isTeal = variant === "teal";
  const textColor = isTeal ? "#fff" : colors.ink;

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
          <Ionicons name="arrow-forward" size={14} color={isTeal ? "#fff" : colors.ink} />
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
    dark: { backgroundColor: "rgba(18,18,59,0.06)", borderColor: "rgba(18,18,59,0.12)" },
    light: { backgroundColor: "rgba(18,18,59,0.06)", borderColor: "rgba(18,18,59,0.12)" },
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
    backgroundColor: colors.dark.surface,
    borderWidth: 1,
    borderColor: colors.dark.surfaceBorder,
    padding: spacing.md,
  },
  cardTinted: {
    backgroundColor: "rgba(244,163,0,0.10)",
    borderColor: "rgba(244,163,0,0.35)",
  },
  ghost: {
    borderRadius: radius.sm + 2,
    borderWidth: 1.5,
    borderColor: "rgba(18,18,59,0.25)",
    backgroundColor: "#FFFFFF",
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
    backgroundColor: "rgba(18,18,59,0.16)",
    alignItems: "center",
    justifyContent: "center",
  },
  btnPrimary: { backgroundColor: colors.amber },
  btnTeal: { backgroundColor: colors.teal },
  btnText: { fontWeight: "700", fontSize: 14 },
  tag: { alignSelf: "flex-start", paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, marginTop: 4 },
});
