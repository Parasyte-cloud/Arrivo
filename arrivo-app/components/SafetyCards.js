import React, { useCallback, useEffect, useRef, useState } from "react";
import { View, Text, TextInput, StyleSheet, Pressable, ActivityIndicator } from "react-native";
import { useTranslation } from "react-i18next";
import { Card, Button } from "./UI";
import { colors, spacing } from "../theme/tokens";
import { useAuth } from "../context/AuthContext";
import { getPickupPin, fileRideComplaint } from "../services/api";
import { RIDER_COMPLAINT_CATEGORIES, descriptionOk, shouldShowPin, spacedPin } from "../utils/safety";

// Cards on the tracking screen: the pickup PIN, and the "report the driver" form.
// Text comes from i18n/locales (the "safety" group).

// Shows the PIN while the driver is on the way. Hides itself when no PIN is needed.
export function PickupPinCard({ rideId, rideStatus }) {
  const { token } = useAuth();
  const { t } = useTranslation();
  const [info, setInfo] = useState(null);

  const load = useCallback(async () => {
    try {
      setInfo(await getPickupPin(token, rideId));
    } catch (e) {
      setInfo(null); // never block the tracking screen over this
    }
  }, [token, rideId]);

  useEffect(() => {
    if (rideStatus !== "accepted") { setInfo(null); return undefined; }
    load();
    const id = setInterval(load, 15000); // disappears once the driver has used it
    return () => clearInterval(id);
  }, [rideStatus, load]);

  if (!shouldShowPin(info)) return null;
  return (
    <Card tone="dark" style={{ marginTop: spacing.md }}>
      <Text style={styles.title}>{t("safety.pin.title")}</Text>
      <Text style={styles.pin}>{spacedPin(info.pin)}</Text>
      <Text style={styles.help}>{t("safety.pin.help")}</Text>
    </Card>
  );
}

export function ReportDriverCard({ rideId }) {
  const { token } = useAuth();
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
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
      await fileRideComplaint(token, { rideId, category, description: text });
      setSent(true);
    } catch (e) {
      // The server's message is already plain English ("You already reported this ride...").
      setError(e && e.status && e.status < 500 && e.message ? e.message : t("safety.report.failed"));
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <View style={{ marginTop: spacing.sm }}>
        <Button label={t("safety.report.button")} variant="ghost" tone="dark" onPress={() => setOpen(true)} />
      </View>
    );
  }
  if (sent) {
    return (
      <Card tone="dark" style={{ marginTop: spacing.md }}>
        <Text style={styles.help}>{t("safety.report.sent")}</Text>
      </Card>
    );
  }
  return (
    <Card tone="dark" style={{ marginTop: spacing.md }}>
      <Text style={styles.title}>{t("safety.report.title")}</Text>
      <Text style={styles.help}>{t("safety.report.help")}</Text>
      <Text style={styles.label}>{t("safety.report.pick")}</Text>
      <View style={styles.chips}>
        {RIDER_COMPLAINT_CATEGORIES.map((c) => (
          <Pressable key={c} onPress={() => setCategory(c)} style={[styles.chip, category === c && styles.chipActive]}>
            <Text style={[styles.chipText, category === c && styles.chipTextActive]}>{t(`safety.cat.${c}`)}</Text>
          </Pressable>
        ))}
      </View>
      <TextInput
        value={text}
        onChangeText={setText}
        placeholder={t("safety.report.describe")}
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
          <Button label={t("safety.report.send")} onPress={submit} disabled={!category || !descriptionOk(text)} />
          <View style={{ height: spacing.sm }} />
          <Button label={t("safety.report.cancel")} variant="ghost" tone="dark" onPress={() => setOpen(false)} />
        </>
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  title: { color: colors.dark.text, fontSize: 16, fontWeight: "700", marginBottom: 4 },
  pin: { color: colors.amber, fontSize: 44, fontWeight: "800", textAlign: "center", letterSpacing: 4, marginVertical: spacing.sm },
  help: { color: colors.dark.textMuted, fontSize: 13.5, lineHeight: 19 },
  label: { color: colors.dark.text, fontSize: 13, fontWeight: "600", marginTop: spacing.sm, marginBottom: 6 },
  error: { color: colors.coral, fontSize: 13, marginTop: spacing.sm },
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
