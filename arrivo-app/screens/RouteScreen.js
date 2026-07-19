import React, { useMemo, useState } from "react";
import { View, Text, StyleSheet, ScrollView, TextInput, Pressable, Switch } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Card, Button } from "../components/UI";
import { MapPlaceholder } from "../components/MapPlaceholder";
import { colors, spacing, radius } from "../theme/tokens";

// Zone/area pricing — ported from the website's booking flow (see
// ridearrivo-website/booking.js AREA_PRICING) so mobile and web charge
// the same fare for the same destination. Keep these two in sync if
// pricing changes on one side.
const AREA_PRICING = {
  "ikeja gra": 27500, "maryland": 30000, "ogba": 30000, "magodo": 32500,
  "surulere": 32500, "yaba": 34500, "anthony": 30000, "anthony village": 30000,
  "ilupeju": 30000, "gbagada": 37500, "allen avenue": 30000, "alausa": 30000,
  "ajao estate": 30000, "victoria island": 45000, "ikoyi": 50000,
  "lekki phase 1": 45000,
  "iyana-ipaja": 47500, "iyana ipaja": 47500, "egbeda": 47500, "akowonjo": 47500,
  "idimu": 52500, "ipaja": 47500, "ayobo": 55000, "baruwa": 55000,
  "alimosho": 50000, "command": 57500, "abule egba": 55000,
  "ijaiye": 47500, "oko oba": 47500, "dopemu": 42500, "shasha": 50000,
  "lekki": 45000, "ajah": 55000, "ikorodu": 50000, "festac": 50000,
  "satellite town": 60000,
};
const DEFAULT_AREA_PRICE = 32000;
const EXCLUDED_AREAS = [
  { name: "Badagry", keywords: ["badagry"] },
  { name: "Epe", keywords: ["epe"] },
  { name: "Ibeju-Lekki", keywords: ["ibeju-lekki", "ibeju lekki"] },
  { name: "Makoko", keywords: ["makoko"] },
];

function findAreaPrice(address) {
  const a = " " + (address || "").toLowerCase() + " ";
  let best = null;
  for (const key in AREA_PRICING) {
    if (a.indexOf(key) !== -1 && (!best || key.length > best.length)) best = key;
  }
  return best ? AREA_PRICING[best] : DEFAULT_AREA_PRICE;
}
function findExcludedArea(address) {
  const a = " " + (address || "").toLowerCase() + " ";
  return EXCLUDED_AREAS.find((area) => area.keywords.some((k) => a.indexOf(k) !== -1)) || null;
}

const VEHICLE_TIER_DELTA = { sedan: 0, suv: 15000, truck: 30000 }; // "truck" id kept stable internally — label is "Executive Vehicle"
const MAX_PASSENGERS = { sedan: 3, suv: 6, truck: 6 };
const FLEET_PRICE = { 2: 70000, 3: 100000 };
const SECURITY_ESCORT_PRICE = 100000;
const VEHICLES = [
  { id: "sedan", label: "Standard Sedan" },
  { id: "suv", label: "Premium SUV" },
  { id: "truck", label: "Executive Vehicle" },
];

// Multipliers for non-one-way bookings only — zone pricing above applies
// to one-way trips, which is the overwhelming majority of airport
// pickups. Full-day/week/month keep the older flat-rate model for now,
// matching how the website still handles those booking types too.
const BOOKING_TYPES = [
  { id: "one_way", label: "One-way pickup", days: 1, multiplier: 1 },
  { id: "full_day", label: "Full day", days: 1, multiplier: 6 },
  { id: "full_week", label: "Full week", days: 7, multiplier: 30 },
  { id: "full_month", label: "Full month", days: 30, multiplier: 100 },
];
const FLAT_BASE_PRICE = { sedan: 8500, suv: 12500, truck: 16000 };

export default function RouteScreen({ navigation }) {
  const [pickup, setPickup] = useState("Murtala Muhammed Airport, T1");
  const [stops, setStops] = useState(["Lekki Phase 1"]);
  const [vehicle, setVehicle] = useState("suv");
  const [bookingType, setBookingType] = useState("one_way");
  const [adults, setAdults] = useState("1");
  const [securityEscort, setSecurityEscort] = useState(false);
  const [fleetSize, setFleetSize] = useState(0); // 0 | 2 | 3

  const addStop = () => setStops((s) => [...s, ""]);
  const updateStop = (i, val) => setStops((s) => s.map((v, idx) => (idx === i ? val : v)));

  const destination = stops[stops.length - 1] || "";
  const excludedArea = useMemo(() => findExcludedArea(destination) || findExcludedArea(pickup), [destination, pickup]);
  const areaPrice = useMemo(() => findAreaPrice(destination), [destination]);
  const selectedBooking = BOOKING_TYPES.find((b) => b.id === bookingType);
  const passengerCount = Math.max(1, Number(adults) || 0);
  const maxForVehicle = MAX_PASSENGERS[vehicle];
  const overCapacity = passengerCount > maxForVehicle;

  const baseFare = useMemo(() => {
    if (bookingType === "one_way") return areaPrice + (VEHICLE_TIER_DELTA[vehicle] || 0);
    return (FLAT_BASE_PRICE[vehicle] || 0) * selectedBooking.multiplier;
  }, [bookingType, areaPrice, vehicle, selectedBooking]);

  const totalFare = useMemo(() => {
    let total = baseFare;
    if (securityEscort) total += SECURITY_ESCORT_PRICE;
    if (fleetSize) total += FLEET_PRICE[fleetSize] || 0;
    return total;
  }, [baseFare, securityEscort, fleetSize]);

  const canConfirm = !excludedArea && !overCapacity;

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

        {excludedArea ? (
          <Card style={{ marginBottom: spacing.md, borderColor: colors.coral, borderWidth: 1 }}>
            <Text style={styles.warningText}>
              We don't currently operate in {excludedArea.name}. Please choose a different pickup or destination.
            </Text>
          </Card>
        ) : null}

        <MapPlaceholder etaLabel={`ETA ~${38 + stops.length * 6} min`} distanceLabel={`${stops.length} stop${stops.length > 1 ? "s" : ""} · ${(28 + stops.length * 6).toFixed(0)}km`} />

        <Card style={{ marginTop: spacing.md, marginBottom: spacing.md }}>
          <Text style={styles.cardLabel}>Passengers</Text>
          <View style={styles.stopRow}>
            <Text style={styles.passengerLabel}>Adults</Text>
            <TextInput
              style={styles.passengerInput}
              value={adults}
              onChangeText={setAdults}
              keyboardType="number-pad"
              placeholderTextColor={colors.textMuted}
            />
          </View>
          {overCapacity ? (
            <Text style={styles.warningText}>
              This vehicle fits up to {maxForVehicle}. Choose a larger vehicle or add fleet accompaniment below for bigger groups.
            </Text>
          ) : null}
        </Card>

        <Card style={{ marginBottom: spacing.md }}>
          <Text style={styles.cardLabel}>Choose a vehicle</Text>
          {VEHICLES.map((v) => {
            const price = bookingType === "one_way"
              ? areaPrice + (VEHICLE_TIER_DELTA[v.id] || 0)
              : (FLAT_BASE_PRICE[v.id] || 0) * selectedBooking.multiplier;
            const tooSmall = passengerCount > MAX_PASSENGERS[v.id];
            return (
              <Pressable
                key={v.id}
                onPress={() => !tooSmall && setVehicle(v.id)}
                style={[styles.vehicleRow, tooSmall && { opacity: 0.4 }]}
                disabled={tooSmall}
              >
                <View>
                  <Text style={[styles.vehicleLabel, vehicle === v.id && { color: colors.amber }]}>
                    {vehicle === v.id ? "● " : "○ "}
                    {v.label}
                  </Text>
                  <Text style={styles.vehicleCapacity}>Fits up to {MAX_PASSENGERS[v.id]} passengers</Text>
                </View>
                <Text style={styles.vehiclePrice}>₦{price.toLocaleString()}</Text>
              </Pressable>
            );
          })}
        </Card>

        <Card style={{ marginBottom: spacing.md }}>
          <View style={styles.toggleRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.cardLabel}>Security escort</Text>
              <Text style={styles.addonNote}>Adds a dedicated security vehicle, +₦{SECURITY_ESCORT_PRICE.toLocaleString()}</Text>
            </View>
            <Switch
              value={securityEscort}
              onValueChange={setSecurityEscort}
              trackColor={{ false: "rgba(18,18,59,0.15)", true: colors.amber }}
            />
          </View>
        </Card>

        <Card style={{ marginBottom: spacing.md }}>
          <Text style={styles.cardLabel}>Fleet accompaniment</Text>
          <View style={styles.bookingRow}>
            {[0, 2, 3].map((n) => (
              <Pressable
                key={n}
                onPress={() => setFleetSize(n)}
                style={[styles.bookingChip, fleetSize === n && styles.bookingChipActive]}
              >
                <Text style={[styles.bookingChipText, fleetSize === n && styles.bookingChipTextActive]}>
                  {n === 0 ? "None" : `${n} vehicles · +₦${FLEET_PRICE[n].toLocaleString()}`}
                </Text>
              </Pressable>
            ))}
          </View>
        </Card>

        <View style={{ height: spacing.lg }} />
        <Button
          label={`Confirm · ₦${totalFare.toLocaleString()}`}
          disabled={!canConfirm}
          onPress={() =>
            navigation.navigate("Checkout", {
              amountNaira: totalFare,
              label: `${VEHICLES.find((v) => v.id === vehicle).label}. ${selectedBooking.label}`,
              pickupAddress: pickup,
              stops,
              vehicleType: vehicle,
              bookingType: selectedBooking.id,
              durationDays: selectedBooking.days,
              securityEscort,
              fleetSize,
            })
          }
        />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  title: { fontSize: 18, fontWeight: "700", color: colors.ink, marginBottom: spacing.md },
  stopRow: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 4 },
  dot: { width: 9, height: 9, borderRadius: 4.5 },
  thread: { width: 2, height: 16, backgroundColor: "#4A4A78", marginLeft: 3.5 },
  stopInput: { color: colors.ink, fontSize: 13, flex: 1, paddingVertical: 6 },
  addStop: { flexDirection: "row", alignItems: "center", gap: 6, marginLeft: 18, marginTop: 4 },
  addStopText: { color: colors.tealBright, fontSize: 12, fontWeight: "600" },
  cardLabel: { color: colors.ink, fontWeight: "600", fontSize: 12, marginBottom: 8 },
  bookingRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  bookingChip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: "rgba(18,18,59,0.2)",
  },
  bookingChipActive: { backgroundColor: colors.amber, borderColor: colors.amber },
  bookingChipText: { color: colors.ink, fontSize: 12, fontWeight: "600" },
  bookingChipTextActive: { color: colors.ink },
  vehicleRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 9,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(18,18,59,0.08)",
  },
  vehicleLabel: { color: colors.ink, fontSize: 13 },
  vehicleCapacity: { color: colors.textMuted, fontSize: 10.5, marginTop: 2, marginLeft: 14 },
  vehiclePrice: { color: colors.ink, fontSize: 13, fontWeight: "700" },
  passengerLabel: { color: colors.ink, fontSize: 13, flex: 1 },
  passengerInput: {
    color: colors.ink, fontSize: 14, fontWeight: "700", width: 60, textAlign: "center",
    backgroundColor: colors.fieldBg, borderRadius: 8, paddingVertical: 6,
  },
  toggleRow: { flexDirection: "row", alignItems: "center" },
  addonNote: { color: colors.textMuted, fontSize: 11, marginTop: 2 },
  warningText: { color: colors.coral, fontSize: 11.5, marginTop: 6, lineHeight: 16 },
});
