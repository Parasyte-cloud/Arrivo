import React, { useState } from "react";
import { View, Text, TextInput, StyleSheet, ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView } from "react-native";
import { Button } from "../components/UI";
import { GradientBackground } from "../components/GradientBackground";
import { colors, spacing } from "../theme/tokens";
import { useAuth } from "../context/AuthContext";
import PhoneInput from "../components/PhoneInput";
import { validatePhone } from "../utils/phoneValidation";
import { useTranslation } from "react-i18next";

// Shown once, right after auth, for any rider whose account is missing a
// WhatsApp number or country of residence — both required fields on the
// password-signup form (see SignupScreen.js), but Google/Apple sign-in only
// ever gives us a name and email, so a brand-new OAuth account can reach
// this app without them. Gated in App.js by checking the real user record
// (not a one-time "isNewAccount" flag), so this only ever appears for an
// account that's actually still missing this data — a password-signup rider
// never sees it, and if someone closes the app mid-way through this screen,
// they land right back on it next launch instead of slipping through with
// an incomplete profile.
export default function CompleteProfileScreen() {
  const { t } = useTranslation();
  const { user, updateProfile, logout } = useAuth();
  // An account made on the website can already have a WhatsApp number or a country.
  // Ask only for what is actually missing, and keep what is already there.
  const hasWhatsapp = Boolean(user?.whatsapp_number);
  const hasCountry = Boolean(user?.country_of_residence);
  const [whatsappDial, setWhatsappDial] = useState("+234");
  const [whatsappNational, setWhatsappNational] = useState("");
  const [country, setCountry] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const submit = async () => {
    setError(null);
    const update = {};
    if (!hasWhatsapp) {
      const phoneResult = validatePhone(whatsappDial, whatsappNational);
      if (!phoneResult.valid) {
        setError(phoneResult.message);
        return;
      }
      update.whatsappNumber = phoneResult.full;
    }
    if (!hasCountry) {
      if (!country.trim()) {
        setError(t("signup.enterCountry"));
        return;
      }
      update.countryOfResidence = country.trim();
    }
    setLoading(true);
    try {
      await updateProfile(update);
      // App.js re-evaluates automatically once the user record updates —
      // no manual navigation needed, same mechanism signup/login already use.
    } catch (e) {
      setError(e.message || "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={{ flex: 1 }}>
      <GradientBackground />
      <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Text style={styles.title}>{t("completeProfile.justACoupleMoreDetails")}</Text>
          <Text style={styles.subtitle}>
            {t("completeProfile.weNeedTheseToKeep")}
          </Text>

          {!hasWhatsapp ? (
            <>
              <Text style={styles.label}>{t("completeProfile.whatsappNumber")}</Text>
              <PhoneInput
                dial={whatsappDial}
                national={whatsappNational}
                onChangeDial={setWhatsappDial}
                onChangeNational={setWhatsappNational}
                placeholder={t("completeProfile.whatsappNumber")}
              />
            </>
          ) : null}

          {!hasCountry ? (
            <>
              <Text style={styles.label}>{t("completeProfile.countryOfResidence")}</Text>
              <TextInput
                style={styles.input}
                placeholder={t("completeProfile.countryOfResidence")}
                placeholderTextColor={colors.textMuted}
                value={country}
                onChangeText={setCountry}
              />
            </>
          ) : null}

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <View style={{ height: spacing.sm }} />
          {loading ? <ActivityIndicator color={colors.amber} /> : <Button label={t("completeProfile.continue")} onPress={submit} />}

          <Text style={styles.logoutLink} onPress={logout}>
            {t("completeProfile.logOut")}
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "transparent", justifyContent: "center" },
  content: { padding: spacing.lg, paddingTop: 60, paddingBottom: 40 },
  title: { fontSize: 22, fontWeight: "700", color: colors.ink, textAlign: "center" },
  subtitle: { fontSize: 12.5, color: colors.textMuted, textAlign: "center", marginTop: 8, marginBottom: spacing.lg, lineHeight: 18 },
  label: { color: colors.textMuted, fontSize: 12, marginTop: 4, marginBottom: 8 },
  input: {
    backgroundColor: colors.fieldBg,
    color: colors.ink,
    borderRadius: 12,
    paddingHorizontal: spacing.md,
    paddingVertical: 14,
    fontSize: 14,
    marginBottom: spacing.sm,
  },
  error: { color: colors.coral, fontSize: 12.5, marginTop: 4, textAlign: "center" },
  logoutLink: { color: colors.tealBright, fontSize: 13, fontWeight: "600", textAlign: "center", marginTop: spacing.lg },
});
