import React, { useState } from "react";
import { View, Text, TextInput, StyleSheet, ActivityIndicator, Pressable, KeyboardAvoidingView, Platform, ScrollView, Modal } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button } from "../components/UI";
import { GradientBackground } from "../components/GradientBackground";
import { colors, spacing } from "../theme/tokens";
import { useAuth } from "../context/AuthContext";
import OAuthButtons from "../components/OAuthButtons";

export default function SignupScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const { signup, loginWithGoogle, loginWithApple } = useAuth();
  const [oauthBusy, setOauthBusy] = useState(false);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
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
    if (!agreedToTerms) {
      setError("You must agree to the data protection and privacy terms to continue.");
      return;
    }
    setLoading(true);
    try {
      await signup({ firstName, lastName, email: email.trim().toLowerCase(), phone, password, agreedToTerms });
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
        <Text style={styles.title}>Drive with RideArrivo</Text>
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
        <TextInput
          style={styles.input}
          placeholder="Phone number"
          placeholderTextColor={colors.textMuted}
          value={phone}
          onChangeText={setPhone}
          keyboardType="phone-pad"
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

        <Modal visible={privacyModalVisible} animationType="slide" transparent onRequestClose={() => setPrivacyModalVisible(false)}>
          <View style={styles.modalOverlay}>
            <View style={styles.modalCard}>
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>Data Protection &amp; Privacy Policy</Text>
                <Pressable onPress={() => setPrivacyModalVisible(false)}>
                  <Text style={styles.modalClose}>✕</Text>
                </Pressable>
              </View>
              <ScrollView style={styles.modalBody}>
                <Text style={styles.modalText}>
                  RideArrivo collects your name, contact details, and driver/vehicle information to
                  verify your identity and let you accept rides. Your data is stored securely and is
                  never sold to third parties.{"\n\n"}
                  For the full policy, visit ridearrivo.com/privacy.html from a browser.
                </Text>
              </ScrollView>
              <Pressable
                style={styles.modalAgreeBtn}
                onPress={() => {
                  setAgreedToTerms(true);
                  setPrivacyModalVisible(false);
                }}
              >
                <Text style={styles.modalAgreeBtnText}>I've read this. I agree</Text>
              </Pressable>
            </View>
          </View>
        </Modal>

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
  subtitle: { fontSize: 12, color: colors.textMuted, textAlign: "center", marginTop: 4, marginBottom: spacing.lg },
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
  modalOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "flex-end" },
  modalCard: { backgroundColor: colors.cream, borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: "75%" },
  modalHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", padding: 20, borderBottomWidth: 1, borderBottomColor: "#e5e5e5" },
  modalTitle: { fontWeight: "700", fontSize: 15, color: colors.ink, flex: 1 },
  modalClose: { fontSize: 18, color: "#888", paddingHorizontal: 8 },
  modalBody: { padding: 20 },
  modalText: { color: colors.ink, fontSize: 13.5, lineHeight: 20 },
  modalAgreeBtn: { backgroundColor: colors.amber, margin: 20, marginTop: 0, padding: 14, borderRadius: 12, alignItems: "center" },
  modalAgreeBtnText: { color: colors.ink, fontWeight: "700", fontSize: 14 },
  error: { color: colors.coral, fontSize: 12.5, marginTop: 4, textAlign: "center" },
  link: { color: colors.tealBright, fontSize: 13, fontWeight: "600", textAlign: "center" },
  dividerRow: { flexDirection: "row", alignItems: "center", gap: 10, marginVertical: spacing.md },
  dividerLine: { flex: 1, height: 1, backgroundColor: "rgba(18,18,59,0.15)" },
  dividerText: { color: colors.textMuted, fontSize: 12 },
  oauthHint: { color: colors.textMuted, fontSize: 11, textAlign: "center", marginTop: 8 },
});
