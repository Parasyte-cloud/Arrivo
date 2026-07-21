import React, { useCallback, useState } from "react";
import { View, Text, StyleSheet, ScrollView, ActivityIndicator, TextInput, Pressable } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { Card, Button, Tag } from "../components/UI";
import { GradientBackground } from "../components/GradientBackground";
import { colors, spacing } from "../theme/tokens";
import { useAuth } from "../context/AuthContext";
import { getOwnerDashboard, addVehicle, updateVehicleAvailability } from "../services/api";

const VEHICLE_TYPES = [
  { id: "sedan", label: "Sedan" },
  { id: "suv", label: "SUV" },
  { id: "truck", label: "Truck / Van" },
  { id: "pickup", label: "Pickup Truck" },
];

function formatNaira(amount) {
  return "₦" + Number(amount || 0).toLocaleString();
}

export default function OwnerScreen() {
  const { token } = useAuth();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [makeModel, setMakeModel] = useState("");
  const [plateNumber, setPlateNumber] = useState("");
  const [vehicleType, setVehicleType] = useState("sedan");
  const [adding, setAdding] = useState(false);

  const [availabilityDrafts, setAvailabilityDrafts] = useState({});
  const [savingAvailabilityId, setSavingAvailabilityId] = useState(null);

  const load = useCallback(async () => {
    try {
      const result = await getOwnerDashboard(token);
      setData(result);
      const drafts = {};
      (result.vehicles || []).forEach((v) => { drafts[v.id] = v.availability_note || ""; });
      setAvailabilityDrafts(drafts);
      setError(null);
    } catch (e) {
      setError(e.message || "Couldn't load your vehicles.");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const submitVehicle = async () => {
    if (!makeModel.trim() || !plateNumber.trim()) {
      setError("Add a make/model and plate number.");
      return;
    }
    setAdding(true);
    setError(null);
    try {
      await addVehicle(token, { makeModel: makeModel.trim(), plateNumber: plateNumber.trim(), vehicleType });
      setMakeModel("");
      setPlateNumber("");
      await load();
    } catch (e) {
      setError(e.message || "Couldn't list this vehicle.");
    } finally {
      setAdding(false);
    }
  };

  const saveAvailability = async (vehicleId) => {
    setSavingAvailabilityId(vehicleId);
    try {
      await updateVehicleAvailability(token, vehicleId, availabilityDrafts[vehicleId]);
      await load();
    } catch (e) {
      setError(e.message || "Couldn't save availability.");
    } finally {
      setSavingAvailabilityId(null);
    }
  };

  if (loading) {
    return (
      <View style={styles.screen}>
        <GradientBackground variant="dark" />
        <View style={[StyleSheet.absoluteFill, { alignItems: "center", justifyContent: "center" }]}>
          <ActivityIndicator color={colors.amber} size="large" />
        </View>
      </View>
    );
  }

  const hasVehicles = data?.vehicles?.length > 0;

  return (
    <View style={styles.screen}>
      <GradientBackground variant="dark" />
      <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingBottom: 40 }}>
        <Text style={styles.title}>Your vehicles</Text>
        {error ? <Text style={styles.errorText}>{error}</Text> : null}

        {hasVehicles ? (
          <Card tone="dark" tinted style={{ marginBottom: spacing.md }}>
            <View style={styles.statsRow}>
              <View>
                <Text style={[styles.statNum, { color: colors.amber }]}>{formatNaira(data.fareThisMonthNaira)}</Text>
                <Text style={styles.statLabel}>Trip volume this month</Text>
              </View>
              <View>
                <Text style={styles.statNum}>{data.tripsThisMonth}</Text>
                <Text style={styles.statLabel}>Trips this month</Text>
              </View>
            </View>
            <Text style={styles.noteText}>
              {data.tripsCompleted} completed trips total. Payouts are handled directly by the RideArrivo team for now — this is trip activity, not an automated payout figure.
            </Text>
          </Card>
        ) : null}

        {hasVehicles ? (
          data.vehicles.map((v) => (
            <Card key={v.id} tone="dark" style={{ marginBottom: spacing.md }}>
              <View style={styles.header}>
                <View>
                  <Text style={styles.vehicleName}>{v.make_model}</Text>
                  <Text style={styles.sub}>{v.plate_number} · {v.vehicle_type?.toUpperCase()}</Text>
                </View>
                <Tag label="Listed" tone="teal" />
              </View>
              <View style={{ height: spacing.sm }} />
              <Text style={styles.cardLabel}>Availability</Text>
              <TextInput
                style={styles.input}
                value={availabilityDrafts[v.id] ?? ""}
                onChangeText={(text) => setAvailabilityDrafts((prev) => ({ ...prev, [v.id]: text }))}
                placeholder="e.g. Mon–Fri 6am–9pm, weekends blackout"
                placeholderTextColor={colors.dark.textMuted}
              />
              <View style={{ height: spacing.sm }} />
              {savingAvailabilityId === v.id ? (
                <ActivityIndicator color={colors.amber} />
              ) : (
                <Button label="Save availability" variant="ghost" tone="dark" onPress={() => saveAvailability(v.id)} />
              )}
            </Card>
          ))
        ) : (
          <Card tone="dark" style={{ marginBottom: spacing.md }}>
            <Text style={styles.noteText}>You haven't listed a vehicle yet. Add one below to get started.</Text>
          </Card>
        )}

        <Card tone="dark">
          <Text style={styles.cardLabel}>List a vehicle</Text>
          <TextInput
            style={styles.input}
            value={makeModel}
            onChangeText={setMakeModel}
            placeholder="Make & model, e.g. Honda CR-V"
            placeholderTextColor={colors.dark.textMuted}
          />
          <View style={{ height: spacing.sm }} />
          <TextInput
            style={styles.input}
            value={plateNumber}
            onChangeText={setPlateNumber}
            placeholder="Plate number"
            placeholderTextColor={colors.dark.textMuted}
            autoCapitalize="characters"
          />
          <View style={{ height: spacing.sm }} />
          <View style={styles.chipRow}>
            {VEHICLE_TYPES.map((t) => (
              <Pressable
                key={t.id}
                onPress={() => setVehicleType(t.id)}
                style={[styles.chip, vehicleType === t.id && styles.chipActive]}
              >
                <Text style={[styles.chipText, vehicleType === t.id && styles.chipTextActive]}>{t.label}</Text>
              </Pressable>
            ))}
          </View>
          <View style={{ height: spacing.md }} />
          {adding ? <ActivityIndicator color={colors.amber} /> : <Button label="List this vehicle" onPress={submitVehicle} trailingIcon />}
        </Card>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.dark.bg0 },
  title: { fontSize: 19, fontWeight: "700", color: colors.dark.text, marginBottom: spacing.md },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" },
  vehicleName: { fontSize: 15, fontWeight: "700", color: colors.dark.text },
  sub: { fontSize: 12, color: colors.dark.textMuted, marginTop: 2 },
  statsRow: { flexDirection: "row", justifyContent: "space-between" },
  statNum: { fontSize: 20, fontWeight: "700", color: colors.dark.text },
  statLabel: { fontSize: 10.5, color: colors.dark.textMuted, marginTop: 2 },
  noteText: { fontSize: 11.5, color: colors.dark.textMuted, marginTop: spacing.sm, lineHeight: 16 },
  cardLabel: { color: colors.dark.text, fontWeight: "600", fontSize: 12, marginBottom: 8 },
  errorText: { color: "#FF9B8A", fontSize: 12, marginBottom: spacing.md, textAlign: "center" },
  input: {
    backgroundColor: colors.dark.fieldBg,
    color: colors.dark.text,
    borderRadius: 10,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    fontSize: 13,
  },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.dark.surfaceBorder,
  },
  chipActive: { backgroundColor: colors.amber, borderColor: colors.amber },
  chipText: { color: colors.dark.text, fontSize: 12.5, fontWeight: "600" },
  chipTextActive: { color: colors.ink },
});
