import React, { useState } from "react";
import { View, Text, StyleSheet, ScrollView, TextInput, Pressable } from "react-native";
import { Card, Button } from "../components/UI";
import { GradientBackground } from "../components/GradientBackground";
import { colors, spacing } from "../theme/tokens";

const OPTIONS = [
  { id: "sedan", label: "Sedan, comfort", price: 45000 },
  { id: "suv", label: "SUV, spacious", price: 65000 },
  { id: "luxury", label: "Luxury", price: 120000 },
];

export default function ChauffeurScreen({ navigation }) {
  const [pickupAddress, setPickupAddress] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [purpose, setPurpose] = useState("");
  const [hours, setHours] = useState("6");
  const [choice, setChoice] = useState("suv");

  const opt = OPTIONS.find((o) => o.id === choice);
  const canConfirm = pickupAddress.trim().length > 0 && date.trim().length > 0 && time.trim().length > 0;

  const confirm = () => {
    navigation.navigate("Checkout", {
      amountNaira: opt.price,
      label: `Chauffeur — ${opt.label} · ${date} ${time} · ${hours}h${purpose ? ` (${purpose})` : ""}`,
      pickupAddress: pickupAddress.trim(),
      stops: [],
      vehicleType: choice,
      bookingType: "full_day",
      durationDays: 1,
    });
  };

  return (
    <View style={styles.screen}>
      <GradientBackground variant="dark" />
      <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingBottom: 40 }}>
        <Text style={styles.title}>Chauffeur for the day</Text>

        <Card tone="dark" style={{ marginBottom: spacing.md }}>
          <Text style={styles.cardLabel}>Pickup address</Text>
          <TextInput
            style={styles.input}
            value={pickupAddress}
            onChangeText={setPickupAddress}
            placeholder="Where should your chauffeur meet you?"
            placeholderTextColor={colors.dark.textMuted}
          />
        </Card>

        <Card tone="dark" style={{ marginBottom: spacing.md }}>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>📅 Date</Text>
            <TextInput
              style={styles.smallInput}
              value={date}
              onChangeText={setDate}
              placeholder="e.g. Sat 25 Jul"
              placeholderTextColor={colors.dark.textMuted}
            />
          </View>
          <View style={styles.divider} />
          <View style={styles.row}>
            <Text style={styles.rowLabel}>🕘 Time</Text>
            <TextInput
              style={styles.smallInput}
              value={time}
              onChangeText={setTime}
              placeholder="e.g. 10:00am"
              placeholderTextColor={colors.dark.textMuted}
            />
          </View>
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

        {!canConfirm ? (
          <Text style={styles.warningText}>Add a pickup address, date, and time to continue.</Text>
        ) : null}

        <View style={{ height: spacing.lg }} />
        <Button label={`Continue · ₦${opt.price.toLocaleString()}`} onPress={confirm} disabled={!canConfirm} trailingIcon />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.dark.bg0 },
  title: { fontSize: 18, fontWeight: "700", color: colors.dark.text, marginBottom: spacing.md },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 8 },
  rowLabel: { color: colors.dark.textMuted, fontSize: 12.5 },
  divider: { height: 1, backgroundColor: colors.dark.hairline },
  smallInput: { color: colors.dark.text, fontSize: 13, textAlign: "right", minWidth: 100 },
  purposeInput: { color: colors.dark.text, fontSize: 13, textAlign: "right", flex: 1, marginLeft: 20 },
  cardLabel: { color: colors.dark.text, fontWeight: "600", fontSize: 12, marginBottom: 8 },
  input: {
    backgroundColor: colors.dark.fieldBg,
    color: colors.dark.text,
    borderRadius: 10,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    fontSize: 13,
  },
  optRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 9,
    borderBottomWidth: 1,
    borderBottomColor: colors.dark.hairline,
  },
  optLabel: { color: colors.dark.text, fontSize: 13 },
  optPrice: { color: colors.dark.text, fontSize: 13, fontWeight: "700" },
  warningText: { color: "#FF9B8A", fontSize: 11.5, marginTop: spacing.sm, textAlign: "center" },
});
