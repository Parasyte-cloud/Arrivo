import React, { useState, useEffect } from "react";
import { View, Text, StyleSheet, ScrollView, Pressable, TextInput, ActivityIndicator, Image, Modal, KeyboardAvoidingView, Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as ImagePicker from "expo-image-picker";
import Svg, { Circle, Line } from "react-native-svg";
import { useTranslation } from "react-i18next";
import { Card, Button } from "../components/UI";
import { GradientBackground } from "../components/GradientBackground";
import { colors, spacing } from "../theme/tokens";
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

// "Verified ID" used to be a static label here with no upload, no status,
// and no logic behind it at all — tapping it did nothing. This maps the
// real id_verification_status (see routes/auth.js submit-id-verification +
// routes/admin.js verify-id) to a short label + color for that row.
function idVerificationBadge(status) {
  if (status === "verified") return { label: "Verified ✓", color: "#8FD9C4" };
  if (status === "pending") return { label: "Pending review", color: colors.amber };
  if (status === "rejected") return { label: "Rejected — resubmit", color: colors.coral };
  return { label: "Not verified", color: colors.dark.textMuted };
}

export default function ProfileScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const { t, i18n } = useTranslation();
  const { user, token, logout, updateProfile } = useAuth();
  const [whatsapp, setWhatsapp] = useState(user?.whatsapp_number || "");
  const [country, setCountry] = useState(user?.country_of_residence || "");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  // "Saved ✓" used to be a one-off `useState(false)` flipped to true right
  // after a successful save — but it had no way to reflect that the data
  // was STILL saved once this screen remounted (e.g. returning from the
  // photo-library picker below tears down and rebuilds this component,
  // resetting all of its local state). The save itself was never lost —
  // updateProfile() below does persist to the backend and refreshes `user`
  // — but the confirmation flag reverting to "Save" made it look like it
  // had been, which is exactly the bug reported. Deriving it from whether
  // the current fields match what's actually on `user` (refreshed from
  // AuthContext, which survives this screen remounting) fixes that: it
  // reflects reality regardless of remounts, not a fragile local flag.
  const hasAnyContactInfo = whatsapp.trim().length > 0 || country.trim().length > 0;
  const isSaved =
    !saving &&
    hasAnyContactInfo &&
    whatsapp === (user?.whatsapp_number || "") &&
    country === (user?.country_of_residence || "");
  const [avatarUri, setAvatarUri] = useState(user?.avatar_url || null);
  const [avatarError, setAvatarError] = useState(null);
  const [trips, setTrips] = useState(null); // null = loading
  const [tripsError, setTripsError] = useState(null);
  const [langModalVisible, setLangModalVisible] = useState(false);

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
    setSaveError(null);
    try {
      await updateProfile({ whatsappNumber: whatsapp, countryOfResidence: country });
      // No setSaved(true) needed — isSaved above recomputes automatically
      // once updateProfile's setUser(data.user) lands, since it compares
      // against the now-updated user.whatsapp_number/country_of_residence.
    } catch (e) {
      // Previously silent — a failed save looked identical to a slow one,
      // with no indication anything had gone wrong.
      setSaveError(e.message || "Couldn't save your details. Please try again.");
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
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 0}
      >
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + spacing.lg, paddingHorizontal: spacing.lg, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
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
            <Button label={isSaved ? "Saved ✓" : "Save"} variant="ghost" tone="dark" onPress={saveContactDetails} />
          )}
          {saveError ? <Text style={styles.errorText}>{saveError}</Text> : null}
        </Card>

        <Card tone="dark" style={{ marginBottom: spacing.md }}>
          <Text style={styles.cardLabel}>{t("profile.language")}</Text>
          <Pressable style={styles.langSelector} onPress={() => setLangModalVisible(true)}>
            <Text style={styles.langSelectorText}>{LANGUAGE_LABELS[i18n.language] || i18n.language}</Text>
            <Text style={styles.langSelectorChevron}>⌄</Text>
          </Pressable>
        </Card>

        <Modal visible={langModalVisible} animationType="slide" transparent onRequestClose={() => setLangModalVisible(false)}>
          <Pressable style={styles.langModalOverlay} onPress={() => setLangModalVisible(false)}>
            <View style={styles.langModalCard} onStartShouldSetResponder={() => true}>
              <Text style={styles.langModalTitle}>{t("profile.language")}</Text>
              {supportedLanguages.map((code) => (
                <Pressable
                  key={code}
                  onPress={() => {
                    changeLanguage(code);
                    setLangModalVisible(false);
                  }}
                  style={styles.langModalRow}
                >
                  <Text style={[styles.langModalRowText, i18n.language === code && styles.langModalRowTextActive]}>
                    {LANGUAGE_LABELS[code] || code}
                  </Text>
                  {i18n.language === code ? <Text style={styles.langModalCheck}>✓</Text> : null}
                </Pressable>
              ))}
            </View>
          </Pressable>
        </Modal>

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
          <Pressable
            style={styles.verifiedIdRow}
            onPress={() => navigation.navigate("VerifyId")}
          >
            <Text style={styles.link}>{t("profile.verifiedId")}</Text>
            <Text style={{ color: idVerificationBadge(user?.id_verification_status).color, fontSize: 12, fontWeight: "600" }}>
              {idVerificationBadge(user?.id_verification_status).label}
            </Text>
          </Pressable>
          <Text style={styles.link}>{t("profile.emergencyContacts")}</Text>
          <Text style={styles.link}>{t("profile.rideSharingPrefs")}</Text>
          <Text style={styles.link}>{t("profile.support")}</Text>
        </Card>

        <Button label={t("profile.logOut")} variant="ghost" tone="dark" onPress={logout} />
      </ScrollView>
      </KeyboardAvoidingView>
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
  langSelector: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: colors.dark.fieldBg,
    borderRadius: 10,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
  },
  langSelectorText: { color: colors.dark.text, fontSize: 13.5, fontWeight: "600" },
  langSelectorChevron: { color: colors.dark.textMuted, fontSize: 16, fontWeight: "700" },
  langModalOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "flex-end" },
  langModalCard: { backgroundColor: colors.dark.bg1, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingBottom: 20 },
  langModalTitle: { color: colors.dark.text, fontWeight: "700", fontSize: 15, padding: 20, paddingBottom: 10 },
  langModalRow: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: 20, paddingVertical: 14, borderTopWidth: 1, borderTopColor: colors.dark.hairline,
  },
  langModalRowText: { color: colors.dark.text, fontSize: 14 },
  langModalRowTextActive: { color: colors.amber, fontWeight: "700" },
  langModalCheck: { color: colors.amber, fontSize: 15, fontWeight: "700" },
  link: { color: colors.dark.text, fontSize: 13, paddingVertical: 10 },
  verifiedIdRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
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
