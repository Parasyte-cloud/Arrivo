import React, { useState } from "react";
import { View, Text, TextInput, StyleSheet, ActivityIndicator, Pressable, KeyboardAvoidingView, Platform } from "react-native";
import { Button } from "../components/UI";
import { GradientBackground } from "../components/GradientBackground";
import { colors, spacing } from "../theme/tokens";
import { useAuth } from "../context/AuthContext";
import { forgotPassword } from "../services/api";

export default function LoginScreen({ navigation }) {
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

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
    } catch (e) {
      setError(e.message || "Invalid email or password");
    } finally {
      setLoading(false);
    }
  };

  const submitForgotPassword = async () => {
    setForgotError(null);
    if (!forgotEmail.trim()) {
      setForgotError("Enter the email on your account.");
      return;
    }
    setForgotLoading(true);
    try {
      await forgotPassword(forgotEmail.trim().toLowerCase());
      setForgotMessage("If an account exists for that email, a reset link has been sent. Check your inbox.");
    } catch (e) {
      setForgotError(e.message || "Something went wrong. Please try again.");
    } finally {
      setForgotLoading(false);
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
        <Text style={styles.subBrand}>DRIVER</Text>
        <View style={{ height: spacing.lg }} />

        {forgotMode ? (
          <>
            <Text style={styles.title}>Reset your password</Text>
            {forgotMessage ? (
              <>
                <Text style={styles.link}>{forgotMessage}</Text>
                <View style={{ height: spacing.lg }} />
                <Pressable onPress={() => { setForgotMode(false); setForgotMessage(null); setForgotEmail(""); }}>
                  <Text style={styles.link}>Back to log in</Text>
                </Pressable>
              </>
            ) : (
              <>
                <TextInput
                  style={styles.input}
                  placeholder="Email"
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
                  <Button label="Send reset link" onPress={submitForgotPassword} />
                )}
                <Pressable onPress={() => { setForgotMode(false); setForgotError(null); }} style={{ marginTop: spacing.lg }}>
                  <Text style={styles.link}>Back to log in</Text>
                </Pressable>
              </>
            )}
          </>
        ) : (
          <>
            <Text style={styles.title}>Welcome back</Text>

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
              placeholder="Password"
              placeholderTextColor={colors.textMuted}
              value={password}
              onChangeText={setPassword}
              secureTextEntry
            />

            {error ? <Text style={styles.error}>{error}</Text> : null}

            <Pressable onPress={() => setForgotMode(true)} style={{ alignSelf: "flex-end", marginTop: 2, marginBottom: spacing.sm }}>
              <Text style={styles.link}>Forgot password?</Text>
            </Pressable>

            {loading ? <ActivityIndicator color={colors.amber} /> : <Button label="Log In" onPress={submit} />}

            <Pressable onPress={() => navigation.navigate("Signup")} style={{ marginTop: spacing.lg }}>
              <Text style={styles.link}>New here? Apply to drive for RideArrivo</Text>
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
  brand: { fontSize: 34, fontWeight: "700", color: colors.ink, textAlign: "center" },
  subBrand: { fontSize: 12, fontWeight: "700", color: colors.amber, textAlign: "center", letterSpacing: 3, marginTop: 2 },
  title: { fontSize: 20, fontWeight: "700", color: colors.ink, marginBottom: spacing.lg, textAlign: "center" },
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
});
