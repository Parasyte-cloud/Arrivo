import React from "react";
import { View, Text, StyleSheet, ScrollView } from "react-native";
import { Card, Button, Tag } from "../components/UI";
import { GradientBackground } from "../components/GradientBackground";
import { colors, spacing } from "../theme/tokens";

export default function OwnerScreen() {
  return (
    <View style={styles.screen}>
      <GradientBackground variant="dark" />
      <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingBottom: 40 }}>
        <View style={styles.header}>
          <View>
            <Text style={styles.title}>Your vehicle</Text>
            <Text style={styles.sub}>Honda CR-V · KJA 224 XL</Text>
          </View>
          <Tag label="Active" tone="teal" />
        </View>

        <Card tone="dark" tinted style={{ marginBottom: spacing.md }}>
          <View style={styles.statsRow}>
            <View>
              <Text style={[styles.statNum, { color: colors.amber }]}>₦186k</Text>
              <Text style={styles.statLabel}>This month</Text>
            </View>
            <View>
              <Text style={styles.statNum}>14</Text>
              <Text style={styles.statLabel}>Trips completed</Text>
            </View>
          </View>
        </Card>

        <Card tone="dark" style={{ marginBottom: spacing.md }}>
          <Text style={styles.cardLabel}>Upcoming availability</Text>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>Mon – Fri</Text>
            <Text style={styles.rowValue}>6am – 9pm</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>Weekend</Text>
            <Text style={styles.rowValue}>Blackout</Text>
          </View>
        </Card>

        <Card tone="dark" style={{ marginBottom: spacing.md }}>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>Next payout</Text>
            <Text style={[styles.rowValue, { fontWeight: "700" }]}>Fri · ₦42,000</Text>
          </View>
        </Card>

        <Button label="View Usage Log" variant="ghost" tone="dark" onPress={() => {}} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.dark.bg0 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: spacing.md },
  title: { fontSize: 17, fontWeight: "700", color: colors.dark.text },
  sub: { fontSize: 12, color: colors.dark.textMuted, marginTop: 2 },
  statsRow: { flexDirection: "row", justifyContent: "space-between" },
  statNum: { fontSize: 22, fontWeight: "700", color: colors.dark.text },
  statLabel: { fontSize: 10.5, color: colors.dark.textMuted, marginTop: 2 },
  cardLabel: { color: colors.dark.text, fontWeight: "600", fontSize: 12, marginBottom: 8 },
  row: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 6 },
  rowLabel: { color: colors.dark.text, fontSize: 12.5 },
  rowValue: { color: colors.dark.text, fontSize: 12.5 },
});
