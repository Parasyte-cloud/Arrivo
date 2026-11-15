import React, { useState } from "react";
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from "react-native";
import { Card } from "./UI";
import { colors, spacing } from "../theme/tokens";
import { metaFor, rowAction, TIER_ORDER } from "../utils/tiers";
import { useTiers } from "../context/TiersContext";

// "Your services": every service, whether it is on, and a way to ask Ops for
// one that is off. Asking never switches anything on, the owner decides.
export default function ServicesCard({ title = "Your services", lead }) {
  const { tiers, ask, legacy, loaded } = useTiers();
  const [busy, setBusy] = useState(null);
  const [message, setMessage] = useState(null);
  if (legacy || !loaded) return null;

  const onAsk = async (slug) => {
    setBusy(slug);
    setMessage(null);
    try {
      await ask(slug);
      setMessage("Sent. RideArrivo Ops will look at it.");
    } catch (e) {
      setMessage(e.message || "Could not send that. Try again.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card tone="dark" style={{ marginBottom: spacing.md }}>
      <Text style={styles.title}>{title}</Text>
      {lead ? <Text style={styles.lead}>{lead}</Text> : null}
      {TIER_ORDER.map((slug) => {
        const m = metaFor(slug, tiers);
        const status = (tiers.find((t) => t.slug === slug) || {}).status || "off";
        const action = rowAction(status);
        return (
          <View key={slug} style={styles.row} accessible accessibilityLabel={`${m.name}, ${action.label}`}>
            <View style={[styles.dot, { backgroundColor: status === "active" ? m.accent : "rgba(18,18,59,0.24)" }]} />
            <View style={{ flex: 1 }}>
              <Text style={styles.name}>{m.name}</Text>
              <Text style={styles.tag}>{m.tagline}</Text>
            </View>
            {action.kind === "ask" ? (
              <Pressable
                onPress={() => onAsk(slug)}
                disabled={busy !== null}
                accessibilityRole="button"
                accessibilityLabel={`${action.label}: ${m.name}`}
                style={({ pressed }) => [styles.ask, pressed && { opacity: 0.8 }, busy !== null && { opacity: 0.5 }]}
              >
                {busy === slug ? <ActivityIndicator color={colors.amber} /> : <Text style={styles.askText}>{action.label}</Text>}
              </Pressable>
            ) : (
              <Text style={[styles.state, status === "active" && { color: "#1F7A5C" }]}>{action.label.toUpperCase()}</Text>
            )}
          </View>
        );
      })}
      {message ? <Text style={styles.message} accessibilityLiveRegion="polite">{message}</Text> : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  title: { color: colors.dark.text, fontSize: 17, fontWeight: "800", marginBottom: 4 },
  lead: { color: colors.dark.textMuted, fontSize: 13.5, lineHeight: 19, marginBottom: spacing.sm },
  row: { minHeight: 56, flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.dark.hairline },
  dot: { width: 10, height: 10, borderRadius: 5 },
  name: { color: colors.dark.text, fontWeight: "700", fontSize: 15 },
  tag: { color: colors.dark.textMuted, fontSize: 12.5 },
  state: { color: colors.dark.textMuted, fontSize: 11, fontWeight: "800", letterSpacing: 1.1 },
  ask: { minHeight: 44, minWidth: 96, paddingHorizontal: 12, borderRadius: 12, borderWidth: 1, borderColor: colors.amber, alignItems: "center", justifyContent: "center" },
  askText: { color: colors.amber, fontWeight: "800", fontSize: 13 },
  message: { color: colors.dark.textMuted, fontSize: 13, marginTop: spacing.sm },
});
