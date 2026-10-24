import React from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, radius, spacing } from "../theme/tokens";

// The row of tiers at the top of Home. One tap switches the whole panel below,
// so riders move between RideArrivo, ArrivoAir and the rest without leaving Home.
export default function TierSwitcher({ tiers, activeId, onChange }) {
  return (
    <View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.row}
        accessibilityRole="tablist"
      >
        {tiers.map((tier) => {
          const active = tier.id === activeId;
          return (
            <Pressable
              key={tier.id}
              onPress={() => onChange(tier.id)}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              accessibilityLabel={tier.label}
              style={({ pressed }) => [styles.chip, active && styles.chipActive, pressed && { opacity: 0.8 }]}
            >
              <Ionicons name={tier.icon} size={18} color={active ? colors.ink : colors.dark.text} />
              <Text style={[styles.chipText, active && styles.chipTextActive]}>{tier.short}</Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { gap: spacing.sm, paddingVertical: spacing.xs, paddingRight: spacing.lg },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    minHeight: 44,
    paddingHorizontal: 16,
    borderRadius: radius.pill,
    backgroundColor: colors.dark.surface,
    borderWidth: 1,
    borderColor: colors.dark.surfaceBorder,
  },
  chipActive: { backgroundColor: colors.amber, borderColor: colors.amber },
  chipText: { color: colors.dark.text, fontSize: 13.5, fontWeight: "700" },
  chipTextActive: { color: colors.ink },
});
