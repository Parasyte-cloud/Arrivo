import React, { useState } from "react";
import { View, Text, TextInput, StyleSheet, ActivityIndicator, Pressable, KeyboardAvoidingView, Platform, ScrollView, Modal, Image } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button } from "../components/UI";
import { GradientBackground } from "../components/GradientBackground";
import { colors, spacing } from "../theme/tokens";
import { PrivacyPolicyModal } from "../components/PrivacyPolicyModal";
import { useAuth } from "../context/AuthContext";
import PhoneInput from "../components/PhoneInput";
import { validateOptionalPhone, DEFAULT_DIAL } from "../utils/phoneValidation";
import OAuthButtons from "../components/OAuthButtons";

export default function SignupScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const { signup, loginWithGoogle, loginWithApple } = useAuth();
  const [oauthBusy, setOauthBusy] = useState(false);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  // Country code is picked, never typed. A driver's number was free text
  // here and got stored bare, but it's what the rider app dials behind
  // "call your driver" — see utils/phoneValidation.js. Same E.164 format
  // and same check as the rider app uses for every number it collects.
  const [phoneDial, setPhoneDial] = useState(DEFAULT_DIAL);
  const [phoneNational, setPhoneNational] = useState("");
  const [password, setPassword] = useState("");
  const [agreedToTerms, setAgreedToTerms] = useState(false);
  const [privacyModalVisible, setPrivacyModalVisible] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const submit = async () => {
    setError(null);
    // The backend's /api/auth/signup requires firstName, lastName (not a
    // single combined name), and agreedToTerms — the form below collects
    // all of them so the request actually matches what the API expects.
    if (!firstName || !lastName || !email || !password) {
      setError("First name, last name, email, and password are required.");
      return;
    }
    // Still optional, exactly as before — but the moment anything is typed
    // it has to be a real number with a country code, rather than being
    // waved through and stored in a format nothing can dial.
    const phoneResult = validateOptionalPhone(phoneDial, phoneNational);
    if (!phoneResult.valid) {
      setError(phoneResult.message);
      return;
    }
    if (!agreedToTerms) {
      setError("You must agree to the data protection and privacy terms to continue.");
      return;
    }
    setLoading(true);
    try {
      await signup({
        firstName, lastName, email: email.trim().toLowerCase(),
        phone: phoneResult.full || undefined,
        password, agreedToTerms,
      });
      // AuthProvider flips isAuthenticated -> App.js moves to the driver profile setup next.
    } catch (e) {
      setError(e.message || "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleIdToken = async (idToken) => {
    setError(null);
    setOauthBusy(true);
    try {
      await loginWithGoogle({ idToken, agreedToTerms });
    } catch (e) {
      setError(e.message || "Couldn't sign you in with Google. Please try again.");
    } finally {
      setOauthBusy(false);
    }
  };

  const handleAppleResult = async ({ identityToken, fullName, error: appleError }) => {
    if (appleError) {
      setError(appleError);
      return;
    }
    setError(null);
    setOauthBusy(true);
    try {
      await loginWithApple({ identityToken, fullName, agreedToTerms });
    } catch (e) {
      setError(e.message || "Couldn't sign you in with Apple. Please try again.");
    } finally {
      setOauthBusy(false);
    }
  };

  return (
    <View style={{ flex: 1 }}>
      <GradientBackground />
      <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView contentContainerStyle={[styles.content, { paddingTop: insets.top + spacing.lg }]} keyboardShouldPersistTaps="handled">
        <Image source={require("../assets/wordmark-brand.png")} style={styles.brand} resizeMode="contain" />
        <Text style={styles.subBrand}>DRIVER</Text>
        <Text style={styles.subtitle}>Step 1 of 2: your account</Text>

        <TextInput style={styles.input} placeholder="First name" placeholderTextColor={colors.textMuted} value={firstName} onChangeText={setFirstName} />
        <TextInput style={styles.input} placeholder="Last name" placeholderTextColor={colors.textMuted} value={lastName} onChangeText={setLastName} />
        <TextInput
          style={styles.input}
          placeholder="Email"
          placeholderTextColor={colors.textMuted}
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          keyboardType="email-address"
        />
        <PhoneInput
          dial={phoneDial}
          national={phoneNational}
          onChangeDial={setPhoneDial}
          onChangeNational={setPhoneNational}
          placeholder="Phone number"
        />
        <TextInput
          style={styles.input}
          placeholder="Password"
          placeholderTextColor={colors.textMuted}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
        />

        <View style={styles.agreeRow}>
          <Pressable onPress={() => setAgreedToTerms(!agreedToTerms)} style={styles.checkboxTouch}>
            <View style={[styles.checkbox, agreedToTerms && styles.checkboxChecked]}>
              {agreedToTerms ? <Text style={styles.checkmark}>✓</Text> : null}
            </View>
          </Pressable>
          <Text style={styles.agreeText}>
            I agree to RideArrivo's{" "}
            <Text style={styles.agreeLink} onPress={() => setPrivacyModalVisible(true)}>
              data protection and privacy policy
            </Text>
            .
          </Text>
        </View>

        <PrivacyPolicyModal
          visible={privacyModalVisible}
          onClose={() => setPrivacyModalVisible(false)}
          onAgree={() => {
            setAgreedToTerms(true);
            setPrivacyModalVisible(false);
          }}
        />

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <View style={{ height: spacing.sm }} />
        {loading ? <ActivityIndicator color={colors.amber} /> : <Button label="Continue" onPress={submit} />}

        <View style={styles.dividerRow}>
          <View style={styles.dividerLine} />
          <Text style={styles.dividerText}>or</Text>
          <View style={styles.dividerLine} />
        </View>

        <OAuthButtons
          disabled={!agreedToTerms}
          busy={oauthBusy}
          onGoogleIdToken={handleGoogleIdToken}
          onGoogleError={setError}
          onAppleResult={handleAppleResult}
        />
        {!agreedToTerms ? (
          <Text style={styles.oauthHint}>Check the box above to sign up with Google or Apple.</Text>
        ) : null}

        <Pressable onPress={() => navigation.navigate("Login")} style={{ marginTop: spacing.lg }}>
          <Text style={styles.link}>Already have an account? Log in</Text>
        </Pressable>
      </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "transparent" },
  content: { padding: spacing.lg, paddingTop: 60, paddingBottom: 40 },
  title: { fontSize: 22, fontWeight: "700", color: colors.ink, textAlign: "center" },
  brand: { width: 200, height: 200 / (2067 / 761), alignSelf: "center" },
  subBrand: { fontSize: 12, fontWeight: "700", color: colors.amber, textAlign: "center", letterSpacing: 3, marginTop: 2 },
  subtitle: { fontSize: 12, color: colors.textMuted, textAlign: "center", marginTop: 6, marginBottom: spacing.lg },
  input: {
    backgroundColor: colors.fieldBg,
    color: colors.ink,
    borderRadius: 12,
    paddingHorizontal: spacing.md,
    paddingVertical: 14,
    fontSize: 14,
    marginBottom: spacing.sm,
  },
  agreeRow: { flexDirection: "row", alignItems: "flex-start", gap: 10, marginTop: spacing.xs, marginBottom: spacing.sm },
  checkboxTouch: { paddingTop: 1 },
  checkbox: {
    width: 20, height: 20, borderRadius: 5, borderWidth: 1.5, borderColor: "rgba(18,18,59,0.35)",
    alignItems: "center", justifyContent: "center",
  },
  checkboxChecked: { backgroundColor: colors.amber, borderColor: colors.amber },
  checkmark: { color: colors.ink, fontSize: 13, fontWeight: "700" },
  agreeText: { color: colors.textMuted, fontSize: 12.5, flex: 1 },
  agreeLink: { color: colors.tealBright, textDecorationLine: "underline" },
  error: { color: colors.coral, fontSize: 12.5, marginTop: 4, textAlign: "center" },
  link: { color: colors.tealBright, fontSize: 13, fontWeight: "600", textAlign: "center" },
  dividerRow: { flexDirection: "row", alignItems: "center", gap: 10, marginVertical: spacing.md },
  dividerLine: { flex: 1, height: 1, backgroundColor: "rgba(18,18,59,0.15)" },
  dividerText: { color: colors.textMuted, fontSize: 12 },
  oauthHint: { color: colors.textMuted, fontSize: 11, textAlign: "center", marginTop: 8 },
});
