import React, { useState } from "react";
import { View, Text, StyleSheet, ScrollView, TextInput, Pressable, Alert } from "react-native";
import { Card, Button } from "../components/UI";
import { GradientBackground } from "../components/GradientBackground";
import { colors, spacing } from "../theme/tokens";

const OPTIONS = [
  { id: "sedan", label: "Sedan, comfort", price: 45000 },
  { id: "suv", label: "SUV, spacious", price: 65000 },
  { id: "luxury", label: "Luxury", price: 120000 },
];

export default function ChauffeurScreen() {
  const [purpose, setPurpose] = useState("");
  const [hours, setHours] = useState("6");
  const [choice, setChoice] = useState("suv");

  const request = () => {
    const opt = OPTIONS.find((o) => o.id === choice);
    Alert.alert(
      "Chauffeur requested",
      `${opt.label} for ${hours} hours${purpose ? ` for ${purpose}` : ""}. Estimated total: ₦${opt.price.toLocaleString()}.\n\n(This is a demo confirmation. Wire this button to your booking API.)`
    );
  };

  return (
    <View style={styles.screen}>
      <GradientBackground variant="dark" />
      <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingBottom: 40 }}>
        <Text style={styles.title}>Chauffeur for the day</Text>

        <Card tone="dark" style={{ marginBottom: spacing.md }}>
          <Field label="📅 Date & time" value="Sat, 12 Jul · 10:00am" />
          <View style={styles.divider} />
          <View style={styles.row}>
            <Text style={styles.rowLabel}>⏱ Duration (hours)</Text>
            <TextInput
              style={styles.smallInput}
              value={hours}
              onChangeText={setHours}
              keyboardType="number-pad"
              placeholderTextColor={colors.dark.textMuted}
            />
          </View>
          <View style={styles.divider} />
          <View style={styles.row}>
            <Text style={styles.rowLabel}>🎯 Purpose</Text>
            <TextInput
              style={styles.purposeInput}
              value={purpose}
              onChangeText={setPurpose}
              placeholder="e.g. Wedding run"
              placeholderTextColor={colors.dark.textMuted}
            />
          </View>
        </Card>

        <Card tone="dark">
          <Text style={styles.cardLabel}>Choose a vehicle</Text>
          {OPTIONS.map((o) => (
            <Pressable key={o.id} onPress={() => setChoice(o.id)} style={styles.optRow}>
              <Text style={[styles.optLabel, choice === o.id && { color: colors.amber }]}>
                {choice === o.id ? "● " : "○ "}
                {o.label}
              </Text>
              <Text style={styles.optPrice}>₦{o.price.toLocaleString()}</Text>
            </Pressable>
          ))}
        </Card>

        <View style={{ height: spacing.lg }} />
        <Button label="Request Chauffeur" onPress={request} trailingIcon />
      </ScrollView>
    </View>
  );
}

function Field({ label, value }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.dark.bg0 },
  title: { fontSize: 18, fontWeight: "700", color: colors.dark.text, marginBottom: spacing.md },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 8 },
  rowLabel: { color: colors.dark.textMuted, fontSize: 12.5 },
  rowValue: { color: colors.dark.text, fontSize: 13 },
  divider: { height: 1, backgroundColor: colors.dark.hairline },
  smallInput: { color: colors.dark.text, fontSize: 13, textAlign: "right", minWidth: 40 },
  purposeInput: { color: colors.dark.text, fontSize: 13, textAlign: "right", flex: 1, marginLeft: 20 },
  cardLabel: { color: colors.dark.text, fontWeight: "600", fontSize: 12, marginBottom: 8 },
  optRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 9,
    borderBottomWidth: 1,
    borderBottomColor: colors.dark.hairline,
  },
  optLabel: { color: colors.dark.text, fontSize: 13 },
  optPrice: { color: colors.dark.text, fontSize: 13, fontWeight: "700" },
});
