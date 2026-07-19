import React, { useState, useEffect } from "react";
import { View, Text, StyleSheet, ScrollView, Pressable, TextInput, ActivityIndicator, Image } from "react-native";
import * as ImagePicker from "expo-image-picker";
import Svg, { Circle, Line } from "react-native-svg";
import { useTranslation } from "react-i18next";
import { Card, Button } from "../components/UI";
import { GradientBackground } from "../components/GradientBackground";
import { colors, spacing, radius } from "../theme/tokens";
import { useAuth } from "../context/AuthContext";
import { supportedLanguages } from "../i18n";
import { getRideHistory } from "../services/api";

const LANGUAGE_LABELS = { en: "English", fr: "Français", zh: "中文", de: "Deutsch", hi: "हिन्दी", es: "Español", pt: "Português" };
const MAX_AVATAR_BYTES = 4 * 1024 * 1024;

function RouteStrip() {
  return (
    <Svg width={14} height={46} viewBox="0 0 14 46">
      <Circle cx={7} cy={6} r={5} fill={colors.tealBright} />
      <Line x1={7} y1={12} x2={7} y2={34} stroke="rgba(255,255,255,0.35)" strokeWidth={2} strokeDasharray="3,3" />
      <Circle cx={7} cy={40} r={5} fill="none" stroke={colors.coral} strokeWidth={2} />
    </Svg>
  );
}

function statusStyle(status) {
  if (status === "completed") return { color: "#8FD9C4" };
  if (status === "cancelled") return { color: "#FF9B8A" };
  return { color: colors.dark.textMuted };
}

export default function ProfileScreen() {
  const { t, i18n } = useTranslation();
  const { user, token, logout, updateProfile } = useAuth();
  const [whatsapp, setWhatsapp] = useState(user?.whatsapp_number || "");
  const [country, setCountry] = useState(user?.country_of_residence || "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [avatarUri, setAvatarUri] = useState(user?.avatar_url || null);
  const [avatarError, setAvatarError] = useState(null);
  const [trips, setTrips] = useState(null); // null = loading
  const [tripsError, setTripsError] = useState(null);

  useEffect(() => {
    getRideHistory(token)
      .then((data) => setTrips(data.rides || []))
      .catch(() => setTripsError("Couldn't load your trips."));
  }, []);

  const changeLanguage = async (code) => {
    try {
      await updateProfile({ preferredLanguage: code });
    } catch (e) {
      // Non-critical — worst case the preference doesn't persist to the
      // server, but the UI still switches immediately via setAppLanguage.
    }
  };

  const saveContactDetails = async () => {
    setSaving(true);
    setSaved(false);
    try {
      await updateProfile({ whatsappNumber: whatsapp, countryOfResidence: country });
      setSaved(true);
    } catch (e) {
      // Keep it simple — the fields just won't show a "saved" confirmation.
    } finally {
      setSaving(false);
    }
  };

  const pickAvatar = async () => {
    setAvatarError(null);
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      setAvatarError("Please allow photo access to change your profile picture.");
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.7,
      base64: true,
    });
    if (result.canceled || !result.assets || !result.assets[0]) return;
    const asset = result.assets[0];

    if (asset.fileSize && asset.fileSize > MAX_AVATAR_BYTES) {
      setAvatarError("Please choose an image smaller than 4MB.");
      return;
    }
    if (!asset.base64) {
      setAvatarError("Couldn't read that photo. Please try another.");
      return;
    }

    const mime = asset.mimeType || "image/jpeg";
    const dataUrl = `data:${mime};base64,${asset.base64}`;
    setAvatarUri(asset.uri);
    try {
      await updateProfile({ avatarDataUrl: dataUrl });
    } catch (e) {
      setAvatarError(e.message || "Couldn't save that photo.");
    }
  };

  return (
    <View style={styles.screen}>
      <GradientBackground variant="dark" />
      <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingBottom: 40 }}>
        <Text style={styles.title}>{t("profile.title")}</Text>

        <Card tone="dark" style={{ marginBottom: spacing.md }}>
          {/* Card's own style prop only affects the outer clipping wrapper (needed for
              the BlurView), not the inner content area, so row layout has to be applied
              to a real child view here rather than passed into Card's style. */}
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md }}>
            <Pressable onPress={pickAvatar} style={styles.avatarCircle}>
              {avatarUri ? (
                <Image source={{ uri: avatarUri }} style={styles.avatarImage} />
              ) : (
                <Text style={styles.avatarInitial}>{(user?.name || "?").charAt(0).toUpperCase()}</Text>
              )}
              <View style={styles.avatarEditBadge}><Text style={styles.avatarEditBadgeText}>✎</Text></View>
            </Pressable>
            <View style={{ flex: 1 }}>
              <Text style={styles.name}>{user?.name || "—"}</Text>
              <Text style={styles.meta}>{user?.email}{user?.phone ? ` · ${user.phone}` : ""}</Text>
            </View>
          </View>
        </Card>
        {avatarError ? <Text style={styles.errorText}>{avatarError}</Text> : null}

        <Card tone="dark" style={{ marginBottom: spacing.md }}>
          <Text style={styles.cardLabel}>Contact details</Text>
          <TextInput
            style={styles.input}
            placeholder="WhatsApp number"
            placeholderTextColor={colors.dark.textMuted}
            value={whatsapp}
            onChangeText={setWhatsapp}
            keyboardType="phone-pad"
          />
          <TextInput
            style={styles.input}
            placeholder="Country of residence"
            placeholderTextColor={colors.dark.textMuted}
            value={country}
            onChangeText={setCountry}
          />
          {saving ? (
            <ActivityIndicator color={colors.amber} />
          ) : (
            <Button label={saved ? "Saved ✓" : "Save"} variant="ghost" tone="dark" onPress={saveContactDetails} />
          )}
        </Card>

        <Card tone="dark" style={{ marginBottom: spacing.md }}>
          <Text style={styles.cardLabel}>{t("profile.language")}</Text>
          <View style={styles.langRow}>
            {supportedLanguages.map((code) => (
              <Pressable
                key={code}
                onPress={() => changeLanguage(code)}
                style={[styles.langChip, i18n.language === code && styles.langChipActive]}
              >
                <Text style={[styles.langChipText, i18n.language === code && styles.langChipTextActive]}>
                  {LANGUAGE_LABELS[code] || code}
                </Text>
              </Pressable>
            ))}
          </View>
        </Card>

        <Text style={styles.sectionTitle}>Your trips</Text>
        {trips === null && !tripsError ? (
          <ActivityIndicator color={colors.amber} style={{ marginBottom: spacing.md }} />
        ) : tripsError ? (
          <Text style={styles.errorText}>{tripsError}</Text>
        ) : trips.length === 0 ? (
          <Text style={styles.meta}>No trips yet.</Text>
        ) : (
          trips.map((ride) => {
            const stops = ride.stops || [];
            const dropoff = stops.length ? stops[stops.length - 1] : "—";
            const date = new Date(ride.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
            return (
              <Card key={ride.id} tone="dark" style={{ marginBottom: spacing.sm }}>
                <View style={{ flexDirection: "row", gap: 10 }}>
                  <RouteStrip />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.tripLabel}>PICKUP</Text>
                    <Text style={styles.tripAddr}>{ride.pickup_address}</Text>
                    <Text style={[styles.tripLabel, { marginTop: 6 }]}>DROP-OFF</Text>
                    <Text style={styles.tripAddr}>{dropoff}</Text>
                  </View>
                </View>
                <View style={styles.tripMetaRow}>
                  <Text style={styles.meta}>{date}</Text>
                  <Text style={[styles.tripStatus, statusStyle(ride.ride_status)]}>{String(ride.ride_status).replace("_", " ")}</Text>
                  <Text style={styles.meta}>₦{Number(ride.fare_naira).toLocaleString()}</Text>
                </View>
              </Card>
            );
          })
        )}

        <Card tone="dark" style={{ marginBottom: spacing.md, marginTop: spacing.md }}>
          <Text style={styles.link}>{t("profile.verifiedId")}</Text>
          <Text style={styles.link}>{t("profile.emergencyContacts")}</Text>
          <Text style={styles.link}>{t("profile.rideSharingPrefs")}</Text>
          <Text style={styles.link}>{t("profile.support")}</Text>
        </Card>

        <Button label={t("profile.logOut")} variant="ghost" tone="dark" onPress={logout} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.dark.bg0 },
  title: { fontSize: 19, fontWeight: "700", color: colors.dark.text, marginBottom: spacing.md },
  name: { color: colors.dark.text, fontSize: 15, fontWeight: "700" },
  meta: { color: colors.dark.textMuted, fontSize: 12, marginTop: 4 },
  cardLabel: { color: colors.dark.text, fontWeight: "600", fontSize: 12, marginBottom: 10 },
  sectionTitle: { color: colors.dark.text, fontWeight: "700", fontSize: 14, marginBottom: 10 },
  input: {
    backgroundColor: colors.dark.fieldBg,
    color: colors.dark.text,
    borderRadius: 10,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    fontSize: 13,
    marginBottom: spacing.sm,
  },
  langRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  langChip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.dark.surfaceBorder,
  },
  langChipActive: { backgroundColor: colors.amber, borderColor: colors.amber },
  langChipText: { color: colors.dark.text, fontSize: 12.5, fontWeight: "600" },
  langChipTextActive: { color: colors.ink },
  link: { color: colors.dark.text, fontSize: 13, paddingVertical: 10 },
  avatarCircle: {
    width: 60, height: 60, borderRadius: 30, backgroundColor: colors.dark.fieldBg,
    alignItems: "center", justifyContent: "center", overflow: "hidden", position: "relative",
  },
  avatarImage: { width: "100%", height: "100%" },
  avatarInitial: { fontSize: 22, fontWeight: "700", color: colors.dark.textMuted },
  avatarEditBadge: {
    position: "absolute", bottom: -2, right: -2, width: 18, height: 18, borderRadius: 9,
    backgroundColor: colors.amber, alignItems: "center", justifyContent: "center",
    borderWidth: 2, borderColor: colors.dark.bg0,
  },
  avatarEditBadgeText: { fontSize: 9, color: colors.ink },
  errorText: { color: "#FF9B8A", fontSize: 12, marginBottom: spacing.md },
  tripLabel: { color: colors.dark.textMuted, fontSize: 9.5, letterSpacing: 0.5 },
  tripAddr: { color: colors.dark.text, fontSize: 12.5 },
  tripMetaRow: {
    flexDirection: "row", justifyContent: "space-between", marginTop: 10, paddingTop: 8,
    borderTopWidth: 1, borderTopColor: colors.dark.hairline,
  },
  tripStatus: { fontSize: 11, fontWeight: "700", textTransform: "capitalize" },
});
