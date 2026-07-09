import React from "react";
import { View, Text, StyleSheet, ScrollView, Pressable } from "react-native";
import { useTranslation } from "react-i18next";
import { Card, Button } from "../components/UI";
import { colors, spacing, radius } from "../theme/tokens";
import { useAuth } from "../context/AuthContext";
import { supportedLanguages } from "../i18n";

const LANGUAGE_LABELS = { en: "English", fr: "Français" };

export default function ProfileScreen() {
  const { t, i18n } = useTranslation();
  const { user, logout, updateProfile } = useAuth();

  const changeLanguage = async (code) => {
    try {
      await updateProfile({ preferredLanguage: code });
    } catch (e) {
      // Non-critical — worst case the preference doesn't persist to the
      // server, but the UI still switches immediately via setAppLanguage.
    }
  };

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingBottom: 40 }}>
        <Text style={styles.title}>{t("profile.title")}</Text>

        <Card style={{ marginBottom: spacing.md }}>
          <Text style={styles.name}>{user?.name || "—"}</Text>
          <Text style={styles.meta}>{user?.email}{user?.phone ? ` · ${user.phone}` : ""}</Text>
        </Card>

        <Card style={{ marginBottom: spacing.md }}>
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

        <Card style={{ marginBottom: spacing.md }}>
          <Text style={styles.link}>{t("profile.verifiedId")}</Text>
          <Text style={styles.link}>{t("profile.emergencyContacts")}</Text>
          <Text style={styles.link}>{t("profile.rideSharingPrefs")}</Text>
          <Text style={styles.link}>{t("profile.support")}</Text>
        </Card>

        <Button label={t("profile.logOut")} variant="ghost" onPress={logout} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.ink },
  title: { fontSize: 19, fontWeight: "700", color: colors.cream, marginBottom: spacing.md },
  name: { color: colors.cream, fontSize: 15, fontWeight: "700" },
  meta: { color: colors.textMuted, fontSize: 12, marginTop: 4 },
  cardLabel: { color: colors.cream, fontWeight: "600", fontSize: 12, marginBottom: 10 },
  langRow: { flexDirection: "row", gap: 8 },
  langChip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.2)",
  },
  langChipActive: { backgroundColor: colors.amber, borderColor: colors.amber },
  langChipText: { color: colors.cream, fontSize: 12.5, fontWeight: "600" },
  langChipTextActive: { color: colors.ink },
  link: { color: colors.cream, fontSize: 13, paddingVertical: 10 },
});
