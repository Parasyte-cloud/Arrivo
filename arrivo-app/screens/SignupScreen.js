import React, { useState } from "react";
import { View, Text, TextInput, StyleSheet, ActivityIndicator, Pressable, KeyboardAvoidingView, Platform } from "react-native";
import { useTranslation } from "react-i18next";
import { Button } from "../components/UI";
import { colors, spacing, radius } from "../theme/tokens";
import { useAuth } from "../context/AuthContext";

const LANGUAGES = [
  { code: "en", label: "English" },
  { code: "fr", label: "Français" },
];

export default function SignupScreen({ navigation }) {
  const { t, i18n } = useTranslation();
  const { signup } = useAuth();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [language, setLanguage] = useState(i18n.language?.startsWith("fr") ? "fr" : "en");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const submit = async () => {
    setError(null);
    if (!name || !email || !password) {
      setError("Name, email, and password are required.");
      return;
    }
    setLoading(true);
    try {
      await signup({ name, email: email.trim().toLowerCase(), phone, password, preferredLanguage: language });
    } catch (e) {
      setError(e.message || "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <View style={styles.content}>
        <Text style={styles.title}>{t("auth.joinArrivo")}</Text>

        <TextInput style={styles.input} placeholder={t("auth.name")} placeholderTextColor={colors.textMuted} value={name} onChangeText={setName} />
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
          placeholder={t("auth.phone")}
          placeholderTextColor={colors.textMuted}
          value={phone}
          onChangeText={setPhone}
          keyboardType="phone-pad"
        />
        <TextInput
          style={styles.input}
          placeholder={t("auth.password")}
          placeholderTextColor={colors.textMuted}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
        />

        <Text style={styles.label}>{t("profile.language")}</Text>
        <View style={styles.langRow}>
          {LANGUAGES.map((l) => (
            <Pressable
              key={l.code}
              onPress={() => setLanguage(l.code)}
              style={[styles.langChip, language === l.code && styles.langChipActive]}
            >
              <Text style={[styles.langChipText, language === l.code && styles.langChipTextActive]}>{l.label}</Text>
            </Pressable>
          ))}
        </View>

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <View style={{ height: spacing.sm }} />
        {loading ? (
          <ActivityIndicator color={colors.amber} />
        ) : (
          <Button label={t("auth.createAccount")} onPress={submit} />
        )}

        <Pressable onPress={() => navigation.navigate("Login")} style={{ marginTop: spacing.lg }}>
          <Text style={styles.link}>{t("auth.haveAccount")}</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.ink, justifyContent: "center" },
  content: { padding: spacing.lg },
  title: { fontSize: 24, fontWeight: "700", color: colors.cream, marginBottom: spacing.lg, textAlign: "center" },
  input: {
    backgroundColor: colors.fieldBg,
    color: colors.cream,
    borderRadius: 12,
    paddingHorizontal: spacing.md,
    paddingVertical: 14,
    fontSize: 14,
    marginBottom: spacing.sm,
  },
  label: { color: colors.textMuted, fontSize: 12, marginTop: 4, marginBottom: 8 },
  langRow: { flexDirection: "row", gap: 8, marginBottom: spacing.sm },
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
  error: { color: colors.coral, fontSize: 12.5, marginTop: 4, textAlign: "center" },
  link: { color: colors.tealBright, fontSize: 13, fontWeight: "600", textAlign: "center" },
});
