import React from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { colors, radius, spacing } from "../theme/tokens";

export function Card({ children, style, tinted }) {
  return (
    <View
      style={[
        styles.card,
        tinted && { backgroundColor: "rgba(244,163,0,0.12)", borderColor: "rgba(244,163,0,0.25)" },
        style,
      ]}
    >
      {children}
    </View>
  );
}

export function Button({ label, onPress, variant = "primary", style, disabled }) {
  const variantStyle =
    variant === "primary" ? styles.btnPrimary : variant === "teal" ? styles.btnTeal : styles.btnGhost;
  const textColor = variant === "ghost" ? colors.cream : colors.ink;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [styles.btnBase, variantStyle, style, (pressed || disabled) && { opacity: 0.7 }]}
    >
      <Text style={[styles.btnText, { color: variant === "teal" ? "#fff" : textColor }]}>{label}</Text>
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
  const bg = tone === "teal" ? "rgba(14,124,123,0.25)" : "rgba(244,163,0,0.2)";
  const fg = tone === "teal" ? colors.tealBright : colors.amber;
  return (
    <View style={[styles.tag, { backgroundColor: bg }]}>
      <Text style={{ color: fg, fontSize: 10, fontWeight: "700" }}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderColor: colors.cardBorder,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
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
  btnGhost: { backgroundColor: "transparent", borderWidth: 1.5, borderColor: "rgba(255,255,255,0.35)" },
  btnText: { fontWeight: "700", fontSize: 14 },
  tag: { alignSelf: "flex-start", paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, marginTop: 4 },
});
