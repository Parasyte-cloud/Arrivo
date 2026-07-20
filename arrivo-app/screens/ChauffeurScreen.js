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

// Multipliers relative to a single day's price, discounted for longer
// commitments — mirrors the ratio RouteScreen uses for its own
// full_day(6)/full_week(30)/full_month(100) multipliers (30/6=5, 100/6≈16.7),
// so a week/month chauffeur booking is priced consistently with the rest
// of the app rather than a separately invented number.
const DURATIONS = [
  { id: "full_day", label: "Single day", days: 1, multiplier: 1 },
  { id: "full_week", label: "Full week", days: 7, multiplier: 5 },
  { id: "full_month", label: "Full month", days: 30, multiplier: 16 },
];

export default function ChauffeurScreen({ navigation }) {
  const [pickupAddress, setPickupAddress] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [purpose, setPurpose] = useState("");
  const [hours, setHours] = useState("6");
  const [choice, setChoice] = useState("suv");
  const [duration, setDuration] = useState("full_day");

  const opt = OPTIONS.find((o) => o.id === choice);
  const selectedDuration = DURATIONS.find((d) => d.id === duration);
  const totalPrice = opt.price * selectedDuration.multiplier;
  const canConfirm = pickupAddress.trim().length > 0 && date.trim().length > 0 && time.trim().length > 0;

  const confirm = () => {
    navigation.navigate("Checkout", {
      amountNaira: totalPrice,
      label: `Chauffeur — ${opt.label} · ${selectedDuration.label} · ${date} ${time}${duration === "full_day" ? ` · ${hours}h/day` : ""}${purpose ? ` (${purpose})` : ""}`,
      pickupAddress: pickupAddress.trim(),
      stops: [],
      vehicleType: choice,
      bookingType: duration,
      durationDays: selectedDuration.days,
    });
  };

  return (
    <View style={styles.screen}>
      <GradientBackground variant="dark" />
      <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingBottom: 40 }}>
        <Text style={styles.title}>Chauffeur</Text>

        <Card tone="dark" style={{ marginBottom: spacing.md }}>
          <Text style={styles.cardLabel}>How long do you need a chauffeur?</Text>
          <View style={styles.bookingRow}>
            {DURATIONS.map((d) => (
              <Pressable
                key={d.id}
                onPress={() => setDuration(d.id)}
                style={[styles.bookingChip, duration === d.id && styles.bookingChipActive]}
              >
                <Text style={[styles.bookingChipText, duration === d.id && styles.bookingChipTextActive]}>{d.label}</Text>
              </Pressable>
            ))}
          </View>
        </Card>

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
          {duration === "full_day" ? (
            <>
              <View style={styles.divider} />
              <View style={styles.row}>
                <Text style={styles.rowLabel}>⏱ Hours that day</Text>
                <TextInput
                  style={styles.smallInput}
                  value={hours}
                  onChangeText={setHours}
                  keyboardType="number-pad"
                  placeholderTextColor={colors.dark.textMuted}
                />
              </View>
            </>
          ) : null}
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
              <Text style={styles.optPrice}>₦{(o.price * selectedDuration.multiplier).toLocaleString()}</Text>
            </Pressable>
          ))}
        </Card>

        {!canConfirm ? (
          <Text style={styles.warningText}>Add a pickup address, date, and time to continue.</Text>
        ) : null}

        <View style={{ height: spacing.lg }} />
        <Button label={`Continue · ₦${totalPrice.toLocaleString()}`} onPress={confirm} disabled={!canConfirm} trailingIcon />
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
  bookingRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  bookingChip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.dark.surfaceBorder,
  },
  bookingChipActive: { backgroundColor: colors.amber, borderColor: colors.amber },
  bookingChipText: { color: colors.dark.text, fontSize: 12, fontWeight: "600" },
  bookingChipTextActive: { color: colors.ink },
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
