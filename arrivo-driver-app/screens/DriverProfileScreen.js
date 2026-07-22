import React, { useState } from "react";
import { View, Text, TextInput, StyleSheet, ScrollView, ActivityIndicator, Pressable, KeyboardAvoidingView, Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Card, Button } from "../components/UI";
import { GradientBackground } from "../components/GradientBackground";
import { colors, spacing, radius } from "../theme/tokens";
import { useAuth } from "../context/AuthContext";
import { saveDriverProfile } from "../services/api";

const LANGUAGES = [
  { code: "en", label: "English" },
  { code: "fr", label: "Français" },
];

export default function DriverProfileScreen({ navigation, onComplete }) {
  const insets = useSafeAreaInsets();
  const { token } = useAuth();
  const [licenseNumber, setLicenseNumber] = useState("");
  const [lasdriNumber, setLasdriNumber] = useState("");
  const [languages, setLanguages] = useState(["en"]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const toggleLanguage = (code) => {
    setLanguages((prev) => (prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]));
  };

  const submit = async () => {
    setError(null);
    if (!licenseNumber) {
      setError("License number is required.");
      return;
    }
    setLoading(true);
    try {
      // No vehicle info collected here on purpose — drivers drive company
      // vehicles, assigned separately by an admin/dispatcher, not a vehicle
      // they bring themselves. The backend already treats `vehicle` as
      // optional (it only creates a vehicles row when makeModel+plateNumber
      // are both present, and drivers.vehicle_id is nullable), so simply
      // omitting it here leaves the driver unassigned until dispatch sets it.
      await saveDriverProfile(token, {
        licenseNumber,
        lasdriNumber,
        spokenLanguages: languages.join(","),
      });
      // App.js renders this screen directly (no navigation prop passed) while a new
      // driver hasn't completed their profile yet, so `navigation` is normally
      // undefined here — `navigation.replace` would throw on that undefined access,
      // get swallowed by the catch block below, and show the new driver a confusing
      // "Cannot read properties of undefined" error instead of moving them into the
      // app, even though the profile save itself succeeded. Optional chaining makes
      // the undefined case safe and falls through to onComplete as intended.
      navigation?.replace ? navigation.replace("Dashboard") : onComplete?.();
    } catch (e) {
      setError(e.message || "Couldn't save your profile. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={styles.screen}>
      <GradientBackground />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 0}
      >
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + spacing.lg, paddingHorizontal: spacing.lg, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>Complete your driver profile</Text>
        <Text style={styles.subtitle}>Step 2 of 2. A few details so we can verify you to drive — your vehicle is assigned separately by RideArrivo</Text>

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
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "transparent" },
  title: { fontSize: 19, fontWeight: "700", color: colors.ink },
  subtitle: { fontSize: 12, color: colors.textMuted, marginTop: 4, marginBottom: spacing.lg },
  cardLabel: { color: colors.ink, fontWeight: "600", fontSize: 12.5, marginBottom: 10 },
  hint: { color: colors.textMuted, fontSize: 11, marginBottom: 10, marginTop: -4 },
  input: {
    backgroundColor: colors.fieldBg,
    color: colors.ink,
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
    borderColor: "rgba(18,18,59,0.2)",
  },
  chipActive: { backgroundColor: colors.amber, borderColor: colors.amber },
  chipText: { color: colors.ink, fontSize: 12.5, fontWeight: "600" },
  chipTextActive: { color: colors.ink },
  error: { color: colors.coral, fontSize: 12.5, marginBottom: spacing.md, textAlign: "center" },
});
