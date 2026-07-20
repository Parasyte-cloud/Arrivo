import React from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { BlurView } from "expo-blur";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { colors, radius, spacing } from "../theme/tokens";

// Real Liquid Glass — BlurView provides genuine native blur (not just a
// translucent color), matching the actual frosted-glass look used
// throughout the website. On Android, expo-blur's real blur is opt-in:
// without experimentalBlurMethod="dimezisBlurView" it silently falls back
// to a flat semi-transparent view with NO blur at all, regardless of the
// intensity prop — that fallback is what was shipping before. The
// cardOverlay/ghostOverlay tint underneath is still there as a subtle fill
// on top of the real blur, not as a substitute for it.
//
// tone="light" (default): frosted-white glass, used on Login/Signup.
// tone="dark": frosted-navy glass, used on every main (post-login) screen —
// pair with <GradientBackground variant="dark" /> so there's real tonal
// variation underneath for the blur to actually soften.
export function Card({ children, style, tinted, tone = "light" }) {
  const dark = tone === "dark";

  const inner = (
    <View style={[styles.cardWrap, dark && styles.cardWrapDark, !dark && style]}>
      <BlurView
        intensity={dark ? 45 : 65}
        tint={dark ? "dark" : "light"}
        experimentalBlurMethod="dimezisBlurView"
        blurReductionFactor={4}
        style={StyleSheet.absoluteFill}
      />
      <View
        style={[
          dark ? styles.cardOverlayDark : styles.cardOverlay,
          tinted && {
            backgroundColor: dark ? "rgba(244,163,0,0.16)" : "rgba(244,163,0,0.14)",
            borderColor: dark ? "rgba(244,163,0,0.4)" : "rgba(244,163,0,0.3)",
          },
        ]}
      >
        {children}
      </View>
      {dark ? (
        <LinearGradient
          pointerEvents="none"
          colors={[colors.dark.surfaceHighlight, "transparent"]}
          start={{ x: 0.5, y: 0 }}
          end={{ x: 0.5, y: 1 }}
          style={styles.glossTop}
        />
      ) : null}
    </View>
  );

  // Dark cards get an outer shadow wrapper — a view can't have both
  // overflow:"hidden" (needed to clip BlurView to the rounded corners) and
  // a visible drop shadow on the same node, so the shadow lives one level
  // up, giving the card real elevation off the dark background.
  return dark ? <View style={[styles.cardShadowWrap, style]}>{inner}</View> : inner;
}

export function Button({ label, onPress, variant = "primary", style, disabled, tone = "light", trailingIcon = false }) {
  const isPrimary = variant === "primary";
  const isTeal = variant === "teal";
  const dark = tone === "dark";
  const textColor = isPrimary ? colors.ink : isTeal ? "#fff" : dark ? colors.dark.text : colors.ink;

  if (variant === "ghost") {
    return (
      <Pressable
        onPress={onPress}
        disabled={disabled}
        style={({ pressed }) => [dark ? styles.ghostWrapDark : styles.ghostWrap, style, (pressed || disabled) && { opacity: 0.7 }]}
      >
        <BlurView
          intensity={dark ? 35 : 50}
          tint={dark ? "dark" : "light"}
          experimentalBlurMethod="dimezisBlurView"
          blurReductionFactor={4}
          style={StyleSheet.absoluteFill}
        />
        <View style={dark ? styles.ghostOverlayDark : styles.ghostOverlay}>
          <Text style={[styles.btnText, { color: dark ? colors.dark.text : colors.ink }]}>{label}</Text>
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
      <LinearGradient
        pointerEvents="none"
        colors={["rgba(255,255,255,0.45)", "transparent"]}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 1 }}
        style={styles.btnGloss}
      />
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
    dark: { backgroundColor: "rgba(255,255,255,0.14)", borderColor: "rgba(255,255,255,0.22)" },
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
  cardShadowWrap: {
    borderRadius: radius.md,
    shadowColor: "#000",
    shadowOpacity: 0.35,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 10 },
    elevation: 8,
  },
  cardWrap: {
    borderRadius: radius.md,
    overflow: "hidden", // required for BlurView to respect the rounded corners
    borderWidth: 1,
    borderColor: colors.surfaceBorder,
  },
  cardWrapDark: {
    borderColor: colors.dark.surfaceBorder,
  },
  cardOverlay: {
    backgroundColor: colors.surface,
    padding: spacing.md,
  },
  cardOverlayDark: {
    backgroundColor: colors.dark.surface,
    padding: spacing.md,
  },
  glossTop: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: "45%",
  },
  ghostWrap: {
    borderRadius: radius.sm + 2,
    overflow: "hidden",
    borderWidth: 1.5,
    borderColor: "rgba(18,18,59,0.25)",
  },
  ghostWrapDark: {
    borderRadius: radius.sm + 2,
    overflow: "hidden",
    borderWidth: 1.5,
    borderColor: colors.dark.surfaceBorder,
  },
  ghostOverlay: {
    backgroundColor: "rgba(255,255,255,0.3)",
    paddingVertical: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  ghostOverlayDark: {
    backgroundColor: "rgba(255,255,255,0.08)",
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
  btnGloss: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: "60%",
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
