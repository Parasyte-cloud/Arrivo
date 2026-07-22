import React, { useState } from "react";
import { View, Text, TextInput, StyleSheet, ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView } from "react-native";
import { Button } from "../components/UI";
import { GradientBackground } from "../components/GradientBackground";
import { colors, spacing } from "../theme/tokens";
import { useAuth } from "../context/AuthContext";
import PhoneInput from "../components/PhoneInput";
import { validatePhone } from "../utils/phoneValidation";

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
  const { updateProfile, logout } = useAuth();
  const [whatsappDial, setWhatsappDial] = useState("+234");
  const [whatsappNational, setWhatsappNational] = useState("");
  const [country, setCountry] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const submit = async () => {
    setError(null);
    const phoneResult = validatePhone(whatsappDial, whatsappNational);
    if (!phoneResult.valid) {
      setError(phoneResult.message);
      return;
    }
    if (!country.trim()) {
      setError("Please enter your country of residence.");
      return;
    }
    setLoading(true);
    try {
      await updateProfile({ whatsappNumber: phoneResult.full, countryOfResidence: country.trim() });
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
          <Text style={styles.title}>Just a couple more details</Text>
          <Text style={styles.subtitle}>
            We need these to keep you in the loop about your rides — driver assignments and any flight
            changes get sent here.
          </Text>

          <Text style={styles.label}>WhatsApp number</Text>
          <PhoneInput
            dial={whatsappDial}
            national={whatsappNational}
            onChangeDial={setWhatsappDial}
            onChangeNational={setWhatsappNational}
            placeholder="WhatsApp number"
          />

          <Text style={styles.label}>Country of residence</Text>
          <TextInput
            style={styles.input}
            placeholder="Country of residence"
            placeholderTextColor={colors.textMuted}
            value={country}
            onChangeText={setCountry}
          />

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <View style={{ height: spacing.sm }} />
          {loading ? <ActivityIndicator color={colors.amber} /> : <Button label="Continue" onPress={submit} />}

          <Text style={styles.logoutLink} onPress={logout}>
            Log out
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
