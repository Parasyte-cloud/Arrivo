import React, { useRef, useState } from "react";
import { View, Text, TextInput, StyleSheet, Pressable, ActivityIndicator } from "react-native";
import { Button } from "./UI";
import { colors, spacing } from "../theme/tokens";
import { useAuth } from "../context/AuthContext";
import { useT } from "../context/LanguageContext";
import { TRANSLATIONS } from "../i18n/translations";
import { verifyPickupPin, fileComplaint } from "../services/api";
import { cleanPin, pinReady, descriptionOk, safetyErrorKey, DRIVER_COMPLAINT_CATEGORIES } from "../utils/safety";

// Shown on the active trip: the pickup PIN box and the "report the rider" form.
// Text comes from i18n/translations.js.

function useErrorText() {
  const { t } = useT();
  return (e) => {
    const key = safetyErrorKey(e, (k) => Boolean(TRANSLATIONS.en[k]));
    if (key) return t(key);
    return e && e.status && e.status < 500 && e.message ? e.message : t("e_generic");
  };
}

// The driver types the rider's PIN. onVerified runs once the server accepts it.
export function PickupPinPrompt({ rideId, onVerified }) {
  const { token } = useAuth();
  const { t } = useT();
  const errText = useErrorText();
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const sending = useRef(false);

  const submit = async () => {
    if (!pinReady(pin) || sending.current) return;
    sending.current = true;
    setBusy(true);
    setError(null);
    try {
      await verifyPickupPin(token, rideId, cleanPin(pin));
      onVerified();
    } catch (e) {
      setError(errText(e));
      setPin("");
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };

  return (
    <View style={styles.box}>
      <Text style={styles.title}>{t("pinTitle")}</Text>
      <Text style={styles.body}>{t("pinHelp")}</Text>
      <TextInput
        value={pin}
        onChangeText={(v) => setPin(cleanPin(v))}
        placeholder={t("pinPlaceholder")}
        placeholderTextColor={colors.dark.textMuted}
        keyboardType="number-pad"
        maxLength={4}
        style={styles.pinInput}
        autoFocus
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <View style={{ height: spacing.sm }} />
      {busy ? <ActivityIndicator color={colors.amber} /> : <Button label={t("pinConfirm")} onPress={submit} disabled={!pinReady(pin)} trailingIcon />}
    </View>
  );
}

// A short form: pick what happened, describe it, send. The rider never sees it.
export function ReportRiderPanel({ rideId, onClose }) {
  const { token } = useAuth();
  const { t } = useT();
  const errText = useErrorText();
  const [category, setCategory] = useState(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [sent, setSent] = useState(false);
  const sending = useRef(false);

  const submit = async () => {
    if (!category || !descriptionOk(text) || sending.current) return;
    sending.current = true;
    setBusy(true);
    setError(null);
    try {
      await fileComplaint(token, { rideId, category, description: text });
      setSent(true);
    } catch (e) {
      setError(errText(e));
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };

  if (sent) {
    return (
      <View style={styles.box}>
        <Text style={styles.body}>{t("reportSent")}</Text>
        <View style={{ height: spacing.sm }} />
        <Button label={t("reportCancel")} variant="ghost" tone="dark" onPress={onClose} />
      </View>
    );
  }

  return (
    <View style={styles.box}>
      <Text style={styles.title}>{t("reportTitle")}</Text>
      <Text style={styles.body}>{t("reportHelp")}</Text>
      <Text style={styles.label}>{t("reportPick")}</Text>
      <View style={styles.chips}>
        {DRIVER_COMPLAINT_CATEGORIES.map((c) => (
          <Pressable key={c} onPress={() => setCategory(c)} style={[styles.chip, category === c && styles.chipActive]}>
            <Text style={[styles.chipText, category === c && styles.chipTextActive]}>{t(`cat_${c}`)}</Text>
          </Pressable>
        ))}
      </View>
      <TextInput
        value={text}
        onChangeText={setText}
        placeholder={t("reportDescribe")}
        placeholderTextColor={colors.dark.textMuted}
        multiline
        maxLength={1000}
        style={styles.textArea}
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <View style={{ height: spacing.sm }} />
      {busy ? (
        <ActivityIndicator color={colors.amber} />
      ) : (
        <>
          <Button label={t("reportSend")} onPress={submit} disabled={!category || !descriptionOk(text)} />
          <View style={{ height: spacing.sm }} />
          <Button label={t("reportCancel")} variant="ghost" tone="dark" onPress={onClose} />
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { backgroundColor: colors.dark.surface, borderColor: colors.dark.surfaceBorder, borderWidth: 1, borderRadius: 16, padding: spacing.md, marginTop: spacing.sm },
  title: { color: colors.dark.text, fontSize: 16, fontWeight: "700", marginBottom: 4 },
  body: { color: colors.dark.textMuted, fontSize: 13.5, lineHeight: 19 },
  label: { color: colors.dark.text, fontSize: 13, fontWeight: "600", marginTop: spacing.sm, marginBottom: 6 },
  error: { color: colors.coral, fontSize: 13, marginTop: spacing.sm },
  pinInput: {
    marginTop: spacing.sm, backgroundColor: colors.dark.fieldBg, borderRadius: 12, color: colors.dark.text,
    fontSize: 28, letterSpacing: 10, textAlign: "center", paddingVertical: 12,
  },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { borderWidth: 1, borderColor: colors.dark.surfaceBorder, borderRadius: 999, paddingVertical: 8, paddingHorizontal: 12 },
  chipActive: { backgroundColor: colors.amber, borderColor: colors.amber },
  chipText: { color: colors.dark.text, fontSize: 13 },
  chipTextActive: { color: colors.ink, fontWeight: "700" },
  textArea: {
    marginTop: spacing.sm, backgroundColor: colors.dark.fieldBg, borderRadius: 12, color: colors.dark.text,
    minHeight: 90, padding: 12, textAlignVertical: "top", fontSize: 14,
  },
});
