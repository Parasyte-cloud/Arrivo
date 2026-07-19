import React, { useState } from "react";
import { View, Text, TextInput, StyleSheet, ActivityIndicator, Pressable, KeyboardAvoidingView, Platform } from "react-native";
import { useTranslation } from "react-i18next";
import { Button } from "../components/UI";
import { colors, spacing } from "../theme/tokens";
import { useAuth } from "../context/AuthContext";

export default function LoginScreen({ navigation }) {
  const { t } = useTranslation();
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

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

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <View style={styles.content}>
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

        <View style={{ height: spacing.sm }} />
        {loading ? (
          <ActivityIndicator color={colors.amber} />
        ) : (
          <Button label={t("auth.login")} onPress={submit} />
        )}

        <Pressable onPress={() => navigation.navigate("Signup")} style={{ marginTop: spacing.lg }}>
          <Text style={styles.link}>{t("auth.needAccount")}</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg, justifyContent: "center" },
  content: { padding: spacing.lg },
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
});
