import React, { useState } from "react";
import { View, Text, StyleSheet, ScrollView, TextInput, Pressable } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Card, Button } from "../components/UI";
import { MapPlaceholder } from "../components/MapPlaceholder";
import { colors, spacing, radius } from "../theme/tokens";

const VEHICLES = [
  { id: "sedan", label: "Sedan", price: 8500 },
  { id: "suv", label: "SUV", price: 12500 },
  { id: "truck", label: "Truck / Van", price: 16000 },
];

// Multipliers are illustrative starting points, not real pricing —
// swap for whatever your actual full-day/week/month rates end up being.
const BOOKING_TYPES = [
  { id: "one_way", label: "One-way pickup", days: 1, multiplier: 1 },
  { id: "full_day", label: "Full day", days: 1, multiplier: 6 },
  { id: "full_week", label: "Full week", days: 7, multiplier: 30 },
  { id: "full_month", label: "Full month", days: 30, multiplier: 100 },
];

export default function RouteScreen({ navigation }) {
  const [pickup, setPickup] = useState("Murtala Muhammed Airport, T1");
  const [stops, setStops] = useState(["Lekki Phase 1"]);
  const [vehicle, setVehicle] = useState("suv");
  const [bookingType, setBookingType] = useState("one_way");

  const addStop = () => setStops((s) => [...s, ""]);
  const updateStop = (i, val) => setStops((s) => s.map((v, idx) => (idx === i ? val : v)));

  const selectedVehicle = VEHICLES.find((v) => v.id === vehicle);
  const selectedBooking = BOOKING_TYPES.find((b) => b.id === bookingType);
  const totalFare = selectedVehicle.price * selectedBooking.multiplier;

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingBottom: 40 }}>
        <Text style={styles.title}>Set your route</Text>

        <Card style={{ marginBottom: spacing.md }}>
          <Text style={styles.cardLabel}>Booking type</Text>
          <View style={styles.bookingRow}>
            {BOOKING_TYPES.map((b) => (
              <Pressable
                key={b.id}
                onPress={() => setBookingType(b.id)}
                style={[styles.bookingChip, bookingType === b.id && styles.bookingChipActive]}
              >
                <Text style={[styles.bookingChipText, bookingType === b.id && styles.bookingChipTextActive]}>{b.label}</Text>
              </Pressable>
            ))}
          </View>
        </Card>

        <Card style={{ marginBottom: spacing.md }}>
          <View style={styles.stopRow}>
            <View style={[styles.dot, { backgroundColor: colors.teal }]} />
            <TextInput style={styles.stopInput} value={pickup} onChangeText={setPickup} placeholderTextColor={colors.textMuted} />
          </View>
          {stops.map((stop, i) => (
            <View key={i} style={styles.stopRow}>
              <View style={styles.thread} />
              <View style={[styles.dot, { backgroundColor: i === stops.length - 1 ? colors.coral : colors.amber }]} />
              <TextInput
                style={styles.stopInput}
                value={stop}
                onChangeText={(v) => updateStop(i, v)}
                placeholder={`Stop ${i + 1}`}
                placeholderTextColor={colors.textMuted}
              />
            </View>
          ))}
          <Pressable onPress={addStop} style={styles.addStop}>
            <Ionicons name="add-circle-outline" size={16} color={colors.tealBright} />
            <Text style={styles.addStopText}>Add destination</Text>
          </Pressable>
        </Card>

        <MapPlaceholder etaLabel={`ETA ~${38 + stops.length * 6} min`} distanceLabel={`${stops.length} stop${stops.length > 1 ? "s" : ""} · ${(28 + stops.length * 6).toFixed(0)}km`} />

        <Card style={{ marginTop: spacing.md }}>
          <Text style={styles.cardLabel}>Choose a vehicle</Text>
          {VEHICLES.map((v) => (
            <Pressable key={v.id} onPress={() => setVehicle(v.id)} style={styles.vehicleRow}>
              <Text style={[styles.vehicleLabel, vehicle === v.id && { color: colors.amber }]}>
                {vehicle === v.id ? "● " : "○ "}
                {v.label}
              </Text>
              <Text style={styles.vehiclePrice}>₦{(v.price * selectedBooking.multiplier).toLocaleString()}</Text>
            </Pressable>
          ))}
        </Card>

        <View style={{ height: spacing.lg }} />
        <Button
          label={`Confirm · ₦${totalFare.toLocaleString()}`}
          onPress={() =>
            navigation.navigate("Checkout", {
              amountNaira: totalFare,
              label: `${selectedVehicle.label} — ${selectedBooking.label}`,
              pickupAddress: pickup,
              stops,
              vehicleType: selectedVehicle.id,
              bookingType: selectedBooking.id,
              durationDays: selectedBooking.days,
            })
          }
        />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.ink },
  title: { fontSize: 18, fontWeight: "700", color: colors.cream, marginBottom: spacing.md },
  stopRow: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 4 },
  dot: { width: 9, height: 9, borderRadius: 4.5 },
  thread: { width: 2, height: 16, backgroundColor: "#4A4A78", marginLeft: 3.5 },
  stopInput: { color: colors.cream, fontSize: 13, flex: 1, paddingVertical: 6 },
  addStop: { flexDirection: "row", alignItems: "center", gap: 6, marginLeft: 18, marginTop: 4 },
  addStopText: { color: colors.tealBright, fontSize: 12, fontWeight: "600" },
  cardLabel: { color: colors.cream, fontWeight: "600", fontSize: 12, marginBottom: 8 },
  bookingRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  bookingChip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.2)",
  },
  bookingChipActive: { backgroundColor: colors.amber, borderColor: colors.amber },
  bookingChipText: { color: colors.cream, fontSize: 12, fontWeight: "600" },
  bookingChipTextActive: { color: colors.ink },
  vehicleRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 9,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(255,255,255,0.08)",
  },
  vehicleLabel: { color: colors.cream, fontSize: 13 },
  vehiclePrice: { color: colors.cream, fontSize: 13, fontWeight: "700" },
});
