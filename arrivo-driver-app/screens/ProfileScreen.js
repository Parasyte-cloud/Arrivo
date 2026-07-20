import React, { useCallback, useState } from "react";
import { View, Text, StyleSheet, ScrollView, ActivityIndicator } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect } from "@react-navigation/native";
import { Card, Button, Tag } from "../components/UI";
import { GradientBackground } from "../components/GradientBackground";
import { colors, spacing } from "../theme/tokens";
import { useAuth } from "../context/AuthContext";
import { getDriverProfile } from "../services/api";

const LANGUAGE_LABELS = { en: "English", fr: "Français" };

export default function ProfileScreen() {
  const insets = useSafeAreaInsets();
  const { user, token, logout } = useAuth();
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);

  useFocusEffect(
    useCallback(() => {
      (async () => {
        try {
          const { driver } = await getDriverProfile(token);
          setProfile(driver);
        } catch (e) {
          // no-op — profile card just won't render vehicle details
        } finally {
          setLoading(false);
        }
      })();
    }, [token])
  );

  return (
    <View style={styles.screen}>
      <GradientBackground variant="dark" />
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + spacing.lg, paddingHorizontal: spacing.lg, paddingBottom: 40 }}>
        <Text style={styles.title}>Profile</Text>

        <Card tone="dark" style={{ marginBottom: spacing.md }}>
          <Text style={styles.name}>{user?.name}</Text>
          <Text style={styles.meta}>{user?.email}{user?.phone ? ` · ${user.phone}` : ""}</Text>
          {profile?.is_verified ? <Tag label="ID Verified" tone="teal" /> : <Tag label="Verification pending" tone="amber" />}
        </Card>

        {loading ? (
          <ActivityIndicator color={colors.amber} />
        ) : profile ? (
          <Card tone="dark" style={{ marginBottom: spacing.md }}>
            <Text style={styles.cardLabel}>Vehicle</Text>
            {profile.make_model && profile.plate_number ? (
              <>
                <Text style={styles.row}>{profile.make_model} · {profile.plate_number}</Text>
                <Text style={styles.rowMuted}>{profile.vehicle_type?.toUpperCase()} · {profile.seats} seats</Text>
              </>
            ) : (
              <Text style={styles.rowMuted}>No vehicle assigned yet — RideArrivo will assign you one before your first ride.</Text>
            )}
            <View style={{ height: spacing.sm }} />
            <Text style={styles.cardLabel}>Languages</Text>
            <Text style={styles.row}>
              {(profile.spoken_languages || "en")
                .split(",")
                .map((c) => LANGUAGE_LABELS[c.trim()] || c)
                .join(", ")}
            </Text>
            <View style={{ height: spacing.sm }} />
            <Text style={styles.cardLabel}>Rating</Text>
            <Text style={styles.row}>★ {profile.rating?.toFixed(1) ?? "5.0"}</Text>
          </Card>
        ) : null}

        <Button label="Log Out" variant="ghost" tone="dark" onPress={logout} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.dark.bg0 },
  title: { fontSize: 19, fontWeight: "700", color: colors.dark.text, marginBottom: spacing.md },
  name: { color: colors.dark.text, fontSize: 15, fontWeight: "700" },
  meta: { color: colors.dark.textMuted, fontSize: 12, marginTop: 4, marginBottom: 8 },
  cardLabel: { color: colors.dark.textMuted, fontWeight: "600", fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 },
  row: { color: colors.dark.text, fontSize: 13.5 },
  rowMuted: { color: colors.dark.textMuted, fontSize: 11.5, marginTop: 2 },
});
