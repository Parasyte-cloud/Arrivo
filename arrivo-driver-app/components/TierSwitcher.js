import React from "react";
import { ScrollView, Pressable, Text, View, StyleSheet } from "react-native";
import { colors, spacing } from "../theme/tokens";
import { metaFor } from "../utils/tiers";
import { useTiers } from "../context/TiersContext";

// "Working on": one chip per service the driver holds. Shown only when they
// hold two or more, because with one there is nothing to switch. Chips are at
// least 44pt tall and announced as tabs for screen readers.
export default function TierSwitcher() {
  const { tiers, active, current, select, legacy } = useTiers();
  if (legacy || active.length < 2) return null;
  return (
    <View style={styles.wrap} accessibilityRole="tablist">
      <Text style={styles.label}>WORKING ON</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
        {active.map((slug) => {
          const m = metaFor(slug, tiers);
          const on = slug === current;
          return (
            <Pressable
              key={slug}
              onPress={() => select(slug)}
              accessibilityRole="tab"
              accessibilityState={{ selected: on }}
              accessibilityLabel={m.name}
              style={({ pressed }) => [styles.chip, on && { borderColor: m.accent, backgroundColor: "rgba(255,255,255,0.14)" }, pressed && { opacity: 0.8 }]}
            >
              <View style={[styles.dot, { backgroundColor: m.accent, opacity: on ? 1 : 0.55 }]} />
              <Text style={[styles.chipText, on && { color: colors.dark.text }]}>{m.name.replace(/^Arrivo/, "")}</Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginBottom: spacing.md },
  label: { color: colors.dark.textMuted, fontSize: 11, fontWeight: "800", letterSpacing: 1.4, marginBottom: 8 },
  row: { gap: 8, paddingRight: spacing.lg },
  chip: {
    minHeight: 44, paddingHorizontal: 16, borderRadius: 999, flexDirection: "row", alignItems: "center", gap: 9,
    borderWidth: 1, borderColor: colors.dark.surfaceBorder, backgroundColor: colors.dark.surface,
  },
  dot: { width: 10, height: 10, borderRadius: 5 },
  chipText: { color: colors.dark.textMuted, fontWeight: "700", fontSize: 14 },
});
