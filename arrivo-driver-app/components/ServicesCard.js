import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { Card } from "./UI";
import { colors, spacing } from "../theme/tokens";
import { metaFor } from "../utils/tiers";
import { useTiers } from "../context/TiersContext";

// "Your services": ONLY the services RideArrivo Ops has switched on for this
// driver. A service that is off is not listed, named or hinted at, and there is
// nothing to ask for here: Ops decides who works what.
export default function ServicesCard({ title = "Your services", lead }) {
  const { tiers, active, legacy, loaded } = useTiers();
  if (legacy || !loaded) return null;

  return (
    <Card tone="dark" style={{ marginBottom: spacing.md }}>
      <Text style={styles.title}>{title}</Text>
      {lead ? <Text style={styles.lead}>{lead}</Text> : null}
      {active.length === 0 ? (
        <Text style={styles.lead}>No service is on for you yet. RideArrivo Ops will switch one on and it will appear here.</Text>
      ) : (
        active.map((slug) => {
          const m = metaFor(slug, tiers);
          return (
            <View key={slug} style={styles.row} accessible accessibilityLabel={`${m.name}, on`}>
              <View style={[styles.dot, { backgroundColor: m.accent }]} />
              <View style={{ flex: 1 }}>
                <Text style={styles.name}>{m.name}</Text>
                <Text style={styles.tag}>{m.tagline}</Text>
              </View>
              <Text style={styles.state}>ON</Text>
            </View>
          );
        })
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  title: { color: colors.dark.text, fontSize: 17, fontWeight: "800", marginBottom: 4 },
  lead: { color: colors.dark.textMuted, fontSize: 13.5, lineHeight: 19, marginBottom: spacing.sm },
  row: { minHeight: 56, flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: "rgba(18,18,59,0.12)" },
  dot: { width: 10, height: 10, borderRadius: 5 },
  name: { color: colors.dark.text, fontWeight: "700", fontSize: 15 },
  tag: { color: colors.dark.textMuted, fontSize: 12.5 },
  state: { color: "#1F7A5C", fontSize: 11, fontWeight: "800", letterSpacing: 1.1 },
});
