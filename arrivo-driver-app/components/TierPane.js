import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { Card } from "./UI";
import { colors, spacing } from "../theme/tokens";
import { metaFor } from "../utils/tiers";
import { useTiers } from "../context/TiersContext";
import ServicesCard from "./ServicesCard";
import { useT } from "../context/LanguageContext";

// What the Dashboard shows for a service that has no jobs in the app yet, or
// when the driver has no service switched on at all. Honest about what is next.
export default function TierPane() {
  const { tiers, current } = useTiers();
  const { t } = useT();
  if (!current) {
    return (
      <ServicesCard
        title={t("svcNoneTitle")}
        lead={t("svcNoneLead")}
      />
    );
  }
  const m = metaFor(current, tiers);
  return (
    <Card tone="dark" style={{ marginBottom: spacing.md, borderColor: m.accent, borderWidth: 1 }}>
      <View style={styles.head}>
        <View style={[styles.dot, { backgroundColor: m.accent }]} />
        <Text style={styles.kicker}>{m.name.toUpperCase()}</Text>
      </View>
      <Text style={styles.title}>{t("svcSwitchedOn", { name: m.name })}</Text>
      <Text style={styles.body}>
        {t("svcQuoteFirst", { name: m.name })}
      </Text>
    </Card>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  kicker: { color: colors.dark.textMuted, fontSize: 11, fontWeight: "800", letterSpacing: 1.4 },
  title: { color: colors.dark.text, fontSize: 19, fontWeight: "800", marginBottom: 8 },
  body: { color: "#6B6B94", fontSize: 14.5, lineHeight: 21 },
});
