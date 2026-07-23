import React, { useState } from "react";
import { View, Text, TextInput, StyleSheet, ActivityIndicator, Pressable, KeyboardAvoidingView, Platform } from "react-native";
import { useTranslation } from "react-i18next";
import { Button } from "../components/UI";
import { GradientBackground } from "../components/GradientBackground";
import { colors, spacing } from "../theme/tokens";
import { useAuth } from "../context/AuthContext";
import { forgotPassword } from "../services/api";
import OAuthButtons from "../components/OAuthButtons";

export default function LoginScreen({ navigation }) {
  const { t } = useTranslation();
  const { login, loginWithGoogle, loginWithApple } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [oauthBusy, setOauthBusy] = useState(false);

  // "Forgot password?" toggles this same screen into a lightweight
  // email-only mode rather than a separate navigation route — the backend
  // (POST /api/auth/forgot-password, already used by the website's own
  // reset flow) emails a reset link pointing at reset-password.html, so
  // this screen's only job is collecting the email and showing that a
  // request went out.
  const [forgotMode, setForgotMode] = useState(false);
  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotLoading, setForgotLoading] = useState(false);
  const [forgotMessage, setForgotMessage] = useState(null);
  const [forgotError, setForgotError] = useState(null);

  const submit = async () => {
    setError(null);
    setLoading(true);
    try {
      await login({ email: email.trim().toLowerCase(), password });
      // AuthProvider flips isAuthenticated -> App.js swaps to the main app automatically.
    } catch (e) {
      setError(e.message || t("auth.invalidCredentials"));
    } finally {
      setLoading(false);
    }
  };

  const submitForgotPassword = async () => {
    setForgotError(null);
    if (!forgotEmail.trim()) {
      setForgotError(t("auth.enterEmailForReset"));
      return;
    }
    setForgotLoading(true);
    try {
      await forgotPassword(forgotEmail.trim().toLowerCase());
      setForgotMessage(t("auth.resetLinkSent"));
    } catch (e) {
      setForgotError(e.message || t("auth.invalidCredentials"));
    } finally {
      setForgotLoading(false);
    }
  };

  // Login and Signup both use the same backend find-or-create endpoint (see
  // routes/auth.js POST /google and /apple) — a brand-new account can just
  // as easily start here as on the Signup screen. Unlike Signup's checkbox
  // gate, there's no separate consent step here: tapping "Continue with
  // Google/Apple" right under the visible privacy-policy notice below IS
  // the agreement action, the same pattern most apps use for a combined
  // sign-in screen (agreedToTerms is still sent through and still enforced
  // server-side for any genuinely new account — this isn't a client-only
  // formality).
  const handleGoogleIdToken = async (idToken) => {
    setError(null);
    setOauthBusy(true);
    try {
      await loginWithGoogle({ idToken, agreedToTerms: true });
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
      await loginWithApple({ identityToken, fullName, agreedToTerms: true });
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
      <View style={styles.content}>
        <Text style={styles.brand}>
          <Text style={{ color: colors.ink }}>Ride</Text>
          <Text style={{ color: colors.amber }}>Arrivo</Text>
        </Text>
        <View style={{ height: spacing.lg }} />

        {forgotMode ? (
          <>
            <Text style={styles.title}>{t("auth.resetPassword")}</Text>
            {forgotMessage ? (
              <>
                <Text style={styles.link}>{forgotMessage}</Text>
                <View style={{ height: spacing.lg }} />
                <Pressable onPress={() => { setForgotMode(false); setForgotMessage(null); setForgotEmail(""); }}>
                  <Text style={styles.link}>{t("auth.backToLogin")}</Text>
                </Pressable>
              </>
            ) : (
              <>
                <TextInput
                  style={styles.input}
                  placeholder={t("auth.email")}
                  placeholderTextColor={colors.textMuted}
                  value={forgotEmail}
                  onChangeText={setForgotEmail}
                  autoCapitalize="none"
                  keyboardType="email-address"
                />
                {forgotError ? <Text style={styles.error}>{forgotError}</Text> : null}
                <View style={{ height: spacing.sm }} />
                {forgotLoading ? (
                  <ActivityIndicator color={colors.amber} />
                ) : (
                  <Button label={t("auth.sendResetLink")} onPress={submitForgotPassword} />
                )}
                <Pressable onPress={() => { setForgotMode(false); setForgotError(null); }} style={{ marginTop: spacing.lg }}>
                  <Text style={styles.link}>{t("auth.backToLogin")}</Text>
                </Pressable>
              </>
            )}
          </>
        ) : (
          <>
            <Text style={styles.title}>{t("auth.welcomeBack")}</Text>

            <TextInput
              style={styles.input}
              placeholder={t("auth.email")}
              placeholderTextColor={colors.textMuted}
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              keyboardType="email-address"
            />
            <TextInput
              style={styles.input}
              placeholder={t("auth.password")}
              placeholderTextColor={colors.textMuted}
              value={password}
              onChangeText={setPassword}
              secureTextEntry
            />

            {error ? <Text style={styles.error}>{error}</Text> : null}

            <Pressable onPress={() => setForgotMode(true)} style={{ alignSelf: "flex-end", marginTop: 2, marginBottom: spacing.sm }}>
              <Text style={styles.link}>{t("auth.forgotPassword")}</Text>
            </Pressable>

            {loading ? (
              <ActivityIndicator color={colors.amber} />
            ) : (
              <Button label={t("auth.login")} onPress={submit} />
            )}

            <View style={styles.dividerRow}>
              <View style={styles.dividerLine} />
              <Text style={styles.dividerText}>or</Text>
              <View style={styles.dividerLine} />
            </View>

            <OAuthButtons
              busy={oauthBusy}
              onGoogleIdToken={handleGoogleIdToken}
              onAppleResult={handleAppleResult}
            />
            <Text style={styles.oauthNotice}>
              By continuing with Google or Apple, you agree to RideArrivo's Data Protection & Privacy Policy.
            </Text>

            <Pressable onPress={() => navigation.navigate("Signup")} style={{ marginTop: spacing.lg }}>
              <Text style={styles.link}>{t("auth.needAccount")}</Text>
            </Pressable>
          </>
        )}
      </View>
    </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "transparent", justifyContent: "center" },
  content: { padding: spacing.lg },
  brand: { fontSize: 34, fontWeight: "700", textAlign: "center" },
  title: { fontSize: 24, fontWeight: "700", color: colors.ink, marginBottom: spacing.lg, textAlign: "center" },
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
  link: { color: colors.tealBright, fontSize: 13, fontWeight: "600", textAlign: "center" },
  dividerRow: { flexDirection: "row", alignItems: "center", gap: 10, marginVertical: spacing.md },
  dividerLine: { flex: 1, height: 1, backgroundColor: "rgba(18,18,59,0.15)" },
  dividerText: { color: colors.textMuted, fontSize: 12 },
  oauthNotice: { color: colors.textMuted, fontSize: 10.5, textAlign: "center", marginTop: 10, lineHeight: 15 },
});
