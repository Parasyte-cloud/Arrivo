import React, { useState } from "react";
import { View, Text, StyleSheet, ScrollView, Pressable, Switch, ActivityIndicator } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Card, Button } from "../components/UI";
import { GradientBackground } from "../components/GradientBackground";
import { colors, spacing, tint } from "../theme/tokens";
import { useAuth } from "../context/AuthContext";
import { useTranslation } from "react-i18next";
import ParasyteSignature from "../components/ParasyteSignature";

const VEHICLE_OPTIONS = [
  { value: null, label: "No preference" },
  { value: "sedan", label: "Sedan" },
  { value: "suv", label: "SUV" },
  { value: "truck", label: "Executive" },
];

const TEMPERATURE_OPTIONS = [
  { value: null, label: "No preference" },
  { value: "cool", label: "Cool" },
  { value: "warm", label: "Warm" },
];

// Real "Ride-sharing preferences" — this used to be a label on Profile with
// nothing behind it. These are standing defaults saved once here via the
// same PATCH /api/auth/me updateProfile() already used for contact
// details/language elsewhere on Profile. Booking screens don't read these
// yet to auto-apply a default vehicle or pass the rest to the driver —
// that's a natural next step once this ships.
export default function RidePreferencesScreen() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const { user, updateProfile } = useAuth();
  const [preferredVehicleType, setPreferredVehicleType] = useState(user?.preferred_vehicle_type ?? null);
  const [quietRide, setQuietRide] = useState(!!user?.quiet_ride);
  const [temperaturePreference, setTemperaturePreference] = useState(user?.temperature_preference ?? null);
  const [childSeatRequired, setChildSeatRequired] = useState(!!user?.child_seat_required);
  const [travelingWithPet, setTravelingWithPet] = useState(!!user?.traveling_with_pet);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [justSaved, setJustSaved] = useState(false);

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    setJustSaved(false);
    try {
      await updateProfile({
        preferredVehicleType,
        quietRide,
        temperaturePreference,
        childSeatRequired,
        travelingWithPet,
      });
      setJustSaved(true);
    } catch (e) {
      setSaveError(e.message || "Couldn't save your preferences. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={styles.screen}>
      <GradientBackground variant="dark" />
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + spacing.lg, paddingHorizontal: spacing.lg, paddingBottom: 40 }}>
        <Text style={styles.title}>{t("ridePreferences.rideSharingPreferences")}</Text>
        <Text style={styles.meta}>{t("ridePreferences.setYourDefaultsOnceYou")}</Text>

        <Card tone="dark" style={{ marginTop: spacing.lg }}>
          <Text style={styles.cardLabel}>{t("ridePreferences.preferredVehicle")}</Text>
          <View style={styles.chipRow}>
            {VEHICLE_OPTIONS.map((opt) => (
              <Pressable
                key={String(opt.value)}
                onPress={() => setPreferredVehicleType(opt.value)}
                style={[styles.chip, preferredVehicleType === opt.value && styles.chipActive]}
              >
                <Text style={[styles.chipText, preferredVehicleType === opt.value && styles.chipTextActive]}>{opt.label}</Text>
              </Pressable>
            ))}
          </View>
        </Card>

        <Card tone="dark" style={{ marginTop: spacing.md }}>
          <Text style={styles.cardLabel}>{t("ridePreferences.cabinTemperature")}</Text>
          <View style={styles.chipRow}>
            {TEMPERATURE_OPTIONS.map((opt) => (
              <Pressable
                key={String(opt.value)}
                onPress={() => setTemperaturePreference(opt.value)}
                style={[styles.chip, temperaturePreference === opt.value && styles.chipActive]}
              >
                <Text style={[styles.chipText, temperaturePreference === opt.value && styles.chipTextActive]}>{opt.label}</Text>
              </Pressable>
            ))}
          </View>
        </Card>

        <Card tone="dark" style={{ marginTop: spacing.md }}>
          <View style={styles.row}>
            <View style={{ flex: 1 }}>
              <Text style={styles.rowLabel}>{t("ridePreferences.quietRide")}</Text>
              <Text style={styles.meta}>{t("ridePreferences.yourDriverWillKeepConversation")}</Text>
            </View>
            <Switch value={quietRide} onValueChange={setQuietRide} trackColor={{ false: tint(0.15), true: colors.amber }} />
          </View>
          <View style={[styles.row, { marginTop: spacing.md }]}>
            <View style={{ flex: 1 }}>
              <Text style={styles.rowLabel}>{t("ridePreferences.childSeatRequired")}</Text>
              <Text style={styles.meta}>{t("ridePreferences.weLlTryToArrange")}</Text>
            </View>
            <Switch value={childSeatRequired} onValueChange={setChildSeatRequired} trackColor={{ false: tint(0.15), true: colors.amber }} />
          </View>
          <View style={[styles.row, { marginTop: spacing.md }]}>
            <View style={{ flex: 1 }}>
              <Text style={styles.rowLabel}>{t("ridePreferences.travelingWithAPet")}</Text>
              <Text style={styles.meta}>{t("ridePreferences.letsYourDriverKnowAhead")}</Text>
            </View>
            <Switch value={travelingWithPet} onValueChange={setTravelingWithPet} trackColor={{ false: tint(0.15), true: colors.amber }} />
          </View>
        </Card>

        {saveError ? <Text style={styles.errorText}>{saveError}</Text> : null}
        {justSaved ? <Text style={styles.savedText}>{t("ridePreferences.preferencesSaved")}</Text> : null}

        <View style={{ height: spacing.lg }} />
        {saving ? <ActivityIndicator color={colors.amber} /> : <Button label={t("ridePreferences.savePreferences")} onPress={save} variant="primary" />}
        <ParasyteSignature />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.dark.bg0 },
  title: { fontSize: 19, fontWeight: "700", color: colors.dark.text, marginBottom: spacing.sm },
  meta: { color: colors.dark.textMuted, fontSize: 12.5, lineHeight: 18 },
  cardLabel: { color: colors.dark.text, fontWeight: "600", fontSize: 12, marginBottom: 10 },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    paddingHorizontal: 14, paddingVertical: 9, borderRadius: 999,
    borderWidth: 1, borderColor: tint(0.15),
  },
  chipActive: { backgroundColor: colors.amber, borderColor: colors.amber },
  chipText: { color: colors.dark.text, fontSize: 12.5, fontWeight: "600" },
  chipTextActive: { color: colors.ink },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  rowLabel: { color: colors.dark.text, fontSize: 13.5, fontWeight: "600", marginBottom: 2 },
  errorText: { color: "#C2362B", fontSize: 12, marginTop: spacing.md, textAlign: "center" },
  savedText: { color: colors.success, fontSize: 12.5, fontWeight: "600", marginTop: spacing.md, textAlign: "center" },
});
