import React, { useState } from "react";
import { View, Text, TextInput, StyleSheet, ActivityIndicator, Pressable, KeyboardAvoidingView, Platform, ScrollView, Modal, Image } from "react-native";
import * as ImagePicker from "expo-image-picker";
import { useTranslation } from "react-i18next";
import { Button } from "../components/UI";
import { colors, spacing, radius } from "../theme/tokens";
import { useAuth } from "../context/AuthContext";
import PhoneInput from "../components/PhoneInput";
import { validatePhone } from "../utils/phoneValidation";

const LANGUAGES = [
  { code: "en", label: "English" },
  { code: "fr", label: "Français" },
];

const MAX_AVATAR_BYTES = 4 * 1024 * 1024;

export default function SignupScreen({ navigation }) {
  const { t, i18n } = useTranslation();
  const { signup } = useAuth();
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [passportNumber, setPassportNumber] = useState("");
  const [phone, setPhone] = useState("");
  const [whatsappDial, setWhatsappDial] = useState("+234");
  const [whatsappNational, setWhatsappNational] = useState("");
  const [country, setCountry] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [agreedToTerms, setAgreedToTerms] = useState(false);
  const [privacyModalVisible, setPrivacyModalVisible] = useState(false);
  const [language, setLanguage] = useState(i18n.language?.startsWith("fr") ? "fr" : "en");
  const [avatarUri, setAvatarUri] = useState(null);
  const [avatarDataUrl, setAvatarDataUrl] = useState(null);
  const [avatarError, setAvatarError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const pickAvatar = async () => {
    setAvatarError(null);
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      setAvatarError("Please allow photo access to add a profile picture.");
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
    setAvatarUri(asset.uri);
    setAvatarDataUrl(`data:${mime};base64,${asset.base64}`);
  };

  const submit = async () => {
    setError(null);
    if (!firstName || !lastName || !email || !password) {
      setError("First name, last name, email, and password are required.");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    const phoneResult = validatePhone(whatsappDial, whatsappNational);
    if (!phoneResult.valid) {
      setError(phoneResult.message);
      return;
    }
    if (!country.trim()) {
      setError("Please enter your country of residence.");
      return;
    }
    if (!agreedToTerms) {
      setError("You must agree to the data protection and privacy terms to continue.");
      return;
    }
    setLoading(true);
    try {
      await signup({
        firstName, lastName, email: email.trim().toLowerCase(), passportNumber, phone,
        password, confirmPassword, agreedToTerms, preferredLanguage: language,
        whatsappNumber: phoneResult.full, countryOfResidence: country.trim(),
        avatarDataUrl: avatarDataUrl || undefined,
      });
    } catch (e) {
      setError(e.message || "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>{t("auth.joinArrivo")}</Text>

        <Pressable onPress={pickAvatar} style={styles.avatarPicker}>
          {avatarUri ? (
            <Image source={{ uri: avatarUri }} style={styles.avatarImage} />
          ) : (
            <Text style={styles.avatarPlus}>＋</Text>
          )}
        </Pressable>
        <Text style={styles.avatarLabel}>Add profile photo</Text>
        {avatarError ? <Text style={styles.error}>{avatarError}</Text> : null}

        <TextInput style={styles.input} placeholder="First name" placeholderTextColor={colors.textMuted} value={firstName} onChangeText={setFirstName} />
        <TextInput style={styles.input} placeholder="Last name" placeholderTextColor={colors.textMuted} value={lastName} onChangeText={setLastName} />
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
          placeholder="Identification number (optional)"
          placeholderTextColor={colors.textMuted}
          value={passportNumber}
          onChangeText={setPassportNumber}
        />
        <Text style={styles.helperText}>Any government-licensed ID: passport, NIN, etc.</Text>
        <TextInput
          style={styles.input}
          placeholder={t("auth.phone")}
          placeholderTextColor={colors.textMuted}
          value={phone}
          onChangeText={setPhone}
          keyboardType="phone-pad"
        />

        <Text style={styles.label}>WhatsApp number</Text>
        <PhoneInput
          dial={whatsappDial}
          national={whatsappNational}
          onChangeDial={setWhatsappDial}
          onChangeNational={setWhatsappNational}
          placeholder="WhatsApp number"
        />

        <TextInput
          style={styles.input}
          placeholder="Country of residence"
          placeholderTextColor={colors.textMuted}
          value={country}
          onChangeText={setCountry}
        />

        <TextInput
          style={styles.input}
          placeholder={t("auth.password")}
          placeholderTextColor={colors.textMuted}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
        />
        <TextInput
          style={styles.input}
          placeholder="Confirm password"
          placeholderTextColor={colors.textMuted}
          value={confirmPassword}
          onChangeText={setConfirmPassword}
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
                  RideArrivo collects your name, contact details, and (if provided) an identification
                  number to verify your identity and provide airport pickup and ride services.
                  Your data is stored securely and is never sold to third parties.{"\n\n"}
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
        {loading ? (
          <ActivityIndicator color={colors.amber} />
        ) : (
          <Button label={t("auth.createAccount")} onPress={submit} />
        )}

        <Pressable onPress={() => navigation.navigate("Login")} style={{ marginTop: spacing.lg }}>
          <Text style={styles.link}>{t("auth.haveAccount")}</Text>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg, paddingTop: 60, paddingBottom: 40 },
  title: { fontSize: 24, fontWeight: "700", color: colors.ink, marginBottom: spacing.lg, textAlign: "center" },
  avatarPicker: {
    width: 84, height: 84, borderRadius: 42, backgroundColor: colors.fieldBg,
    alignSelf: "center", alignItems: "center", justifyContent: "center",
    borderWidth: 1.5, borderColor: "rgba(18,18,59,0.2)", borderStyle: "dashed", overflow: "hidden",
  },
  avatarImage: { width: "100%", height: "100%" },
  avatarPlus: { fontSize: 30, color: colors.textMuted },
  avatarLabel: { color: colors.tealBright, fontSize: 12, fontWeight: "700", textAlign: "center", marginTop: 8, marginBottom: spacing.md },
  input: {
    backgroundColor: colors.fieldBg,
    color: colors.ink,
    borderRadius: 12,
    paddingHorizontal: spacing.md,
    paddingVertical: 14,
    fontSize: 14,
    marginBottom: spacing.sm,
  },
  label: { color: colors.textMuted, fontSize: 12, marginTop: 4, marginBottom: 8 },
  langRow: { flexDirection: "row", gap: 8, marginBottom: spacing.md },
  langChip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: "rgba(18,18,59,0.2)",
  },
  langChipActive: { backgroundColor: colors.amber, borderColor: colors.amber },
  langChipText: { color: colors.ink, fontSize: 12.5, fontWeight: "600" },
  langChipTextActive: { color: colors.ink },
  helperText: { color: colors.textMuted, fontSize: 11, marginTop: -6, marginBottom: 10 },
  agreeRow: { flexDirection: "row", alignItems: "flex-start", gap: 10, marginBottom: spacing.sm },
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
});
