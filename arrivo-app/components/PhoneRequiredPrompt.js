// Shown on the booking screens when the server says the rider has no phone
// number on file (code PHONE_REQUIRED, see arrivo-backend/services/riderPhone.js).
// They add it right here instead of being sent off to Profile, it's saved to
// their account, and the quote runs again.
import React, { useState } from "react";
import { View, Text, StyleSheet } from "react-native";
import { useTranslation } from "react-i18next";
import { Button } from "./UI";
import PhoneInput from "./PhoneInput";
import { useAuth } from "../context/AuthContext";
import { validatePhone, DEFAULT_DIAL } from "../utils/phoneValidation";
import { messageWithCode } from "../utils/errorRef";
import { colors } from "../theme/tokens";

export default function PhoneRequiredPrompt({ onSaved }) {
  const { t } = useTranslation();
  const { updateProfile } = useAuth();
  const [dial, setDial] = useState(DEFAULT_DIAL);
  const [national, setNational] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const save = async () => {
    const result = validatePhone(dial, national);
    if (!result.valid) {
      setError(result.message);
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await updateProfile({ phone: result.full });
      onSaved && onSaved(result.full);
    } catch (e) {
      setError(messageWithCode(e, t("phoneRequired.failed")));
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={styles.box}>
      <Text style={styles.title}>{t("phoneRequired.title")}</Text>
      <Text style={styles.body}>{t("phoneRequired.body")}</Text>
      <PhoneInput dial={dial} national={national} onChangeDial={setDial} onChangeNational={setNational} placeholder={t("phoneRequired.placeholder")} tone="dark" />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Button label={saving ? t("phoneRequired.saving") : t("phoneRequired.save")} onPress={save} disabled={saving} tone="dark" style={{ marginTop: 10 }} />
    </View>
  );
}

const styles = StyleSheet.create({
  box: { marginTop: 10, padding: 14, borderRadius: 14, borderWidth: 1, borderColor: "#D9A86C", backgroundColor: "rgba(244,163,0,0.08)" },
  title: { color: colors.dark.text, fontSize: 15, fontWeight: "700", marginBottom: 4 },
  body: { color: colors.dark.textMuted, fontSize: 13, lineHeight: 18, marginBottom: 10 },
  error: { color: "#FF9B8A", fontSize: 12, marginTop: 6, lineHeight: 16 },
});
