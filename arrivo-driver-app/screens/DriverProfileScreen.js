import React, { useState } from "react";
import { View, Text, TextInput, StyleSheet, ScrollView, ActivityIndicator, Pressable } from "react-native";
import { Card, Button } from "../components/UI";
import { colors, spacing, radius } from "../theme/tokens";
import { useAuth } from "../context/AuthContext";
import { saveDriverProfile } from "../services/api";

const VEHICLE_TYPES = [
  { id: "sedan", label: "Sedan" },
  { id: "suv", label: "SUV" },
  { id: "truck", label: "Truck / Van" },
];

const LANGUAGES = [
  { code: "en", label: "English" },
  { code: "fr", label: "Français" },
];

export default function DriverProfileScreen({ navigation, onComplete }) {
  const { token } = useAuth();
  const [licenseNumber, setLicenseNumber] = useState("");
  const [lasdriNumber, setLasdriNumber] = useState("");
  const [makeModel, setMakeModel] = useState("");
  const [plateNumber, setPlateNumber] = useState("");
  const [vehicleType, setVehicleType] = useState("sedan");
  const [languages, setLanguages] = useState(["en"]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const toggleLanguage = (code) => {
    setLanguages((prev) => (prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]));
  };

  const submit = async () => {
    setError(null);
    if (!licenseNumber || !makeModel || !plateNumber) {
      setError("License number, vehicle, and plate number are required.");
      return;
    }
    setLoading(true);
    try {
      await saveDriverProfile(token, {
        licenseNumber,
        lasdriNumber,
        spokenLanguages: languages.join(","),
        vehicle: { makeModel, plateNumber, vehicleType, seats: vehicleType === "truck" ? 3 : vehicleType === "suv" ? 6 : 4 },
      });
      navigation.replace ? navigation.replace("Dashboard") : onComplete?.();
    } catch (e) {
      setError(e.message || "Couldn't save your profile. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingBottom: 40 }}>
        <Text style={styles.title}>Complete your driver profile</Text>
        <Text style={styles.subtitle}>Step 2 of 2 — this is what riders will see before their pickup</Text>

        <Card style={{ marginBottom: spacing.md }}>
          <Text style={styles.cardLabel}>License & verification</Text>
          <TextInput
            style={styles.input}
            placeholder="Driver's license number"
            placeholderTextColor={colors.textMuted}
            value={licenseNumber}
            onChangeText={setLicenseNumber}
          />
          <TextInput
            style={styles.input}
            placeholder="LASDRI number"
            placeholderTextColor={colors.textMuted}
            value={lasdriNumber}
            onChangeText={setLasdriNumber}
          />
        </Card>

        <Card style={{ marginBottom: spacing.md }}>
          <Text style={styles.cardLabel}>Vehicle</Text>
          <TextInput
            style={styles.input}
            placeholder="Make & model, e.g. Toyota Highlander"
            placeholderTextColor={colors.textMuted}
            value={makeModel}
            onChangeText={setMakeModel}
          />
          <TextInput
            style={styles.input}
            placeholder="Plate number"
            placeholderTextColor={colors.textMuted}
            value={plateNumber}
            onChangeText={setPlateNumber}
            autoCapitalize="characters"
          />
          <View style={styles.chipRow}>
            {VEHICLE_TYPES.map((v) => (
              <Pressable key={v.id} onPress={() => setVehicleType(v.id)} style={[styles.chip, vehicleType === v.id && styles.chipActive]}>
                <Text style={[styles.chipText, vehicleType === v.id && styles.chipTextActive]}>{v.label}</Text>
              </Pressable>
            ))}
          </View>
        </Card>

        <Card style={{ marginBottom: spacing.lg }}>
          <Text style={styles.cardLabel}>Languages you speak</Text>
          <Text style={styles.hint}>Shown to riders so tourists know they can communicate with you</Text>
          <View style={styles.chipRow}>
            {LANGUAGES.map((l) => (
              <Pressable key={l.code} onPress={() => toggleLanguage(l.code)} style={[styles.chip, languages.includes(l.code) && styles.chipActive]}>
                <Text style={[styles.chipText, languages.includes(l.code) && styles.chipTextActive]}>{l.label}</Text>
              </Pressable>
            ))}
          </View>
        </Card>

        {error ? <Text style={styles.error}>{error}</Text> : null}

        {loading ? <ActivityIndicator color={colors.amber} /> : <Button label="Save & Continue" onPress={submit} />}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.ink },
  title: { fontSize: 19, fontWeight: "700", color: colors.cream },
  subtitle: { fontSize: 12, color: colors.textMuted, marginTop: 4, marginBottom: spacing.lg },
  cardLabel: { color: colors.cream, fontWeight: "600", fontSize: 12.5, marginBottom: 10 },
  hint: { color: colors.textMuted, fontSize: 11, marginBottom: 10, marginTop: -4 },
  input: {
    backgroundColor: colors.fieldBg,
    color: colors.cream,
    borderRadius: 10,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    fontSize: 13,
    marginBottom: spacing.sm,
  },
  chipRow: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.2)",
  },
  chipActive: { backgroundColor: colors.amber, borderColor: colors.amber },
  chipText: { color: colors.cream, fontSize: 12.5, fontWeight: "600" },
  chipTextActive: { color: colors.ink },
  error: { color: colors.coral, fontSize: 12.5, marginBottom: spacing.md, textAlign: "center" },
});
