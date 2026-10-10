import React, { useCallback, useState } from "react";
import { View, Text, StyleSheet, ScrollView, Image, ActivityIndicator } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect } from "@react-navigation/native";
import * as ImagePicker from "expo-image-picker";
import { Card, Button } from "../components/UI";
import { GradientBackground } from "../components/GradientBackground";
import { colors, spacing } from "../theme/tokens";
import { useAuth } from "../context/AuthContext";
import { useT } from "../context/LanguageContext";
import { TRANSLATIONS } from "../i18n/translations";
import { getSelfieStatus, submitSelfie } from "../services/api";
import { safetyErrorKey, selfieNotice } from "../utils/safety";

// The driver selfie check. Shows the code to hold up, opens the front camera,
// sends the photo. A person at RideArrivo compares it with the profile photo.
// Text comes from i18n/translations.js.

export default function SelfieScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const { token } = useAuth();
  const { t } = useT();
  const [status, setStatus] = useState(null);
  const [photo, setPhoto] = useState(null); // data URL
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);

  const errText = useCallback((e) => {
    const key = safetyErrorKey(e, (k) => Boolean(TRANSLATIONS.en[k]));
    if (key) return t(key);
    return e && e.status && e.status < 500 && e.message ? e.message : t("e_generic");
  }, [t]);

  const load = useCallback(async () => {
    try {
      setStatus(await getSelfieStatus(token));
      setError(null);
    } catch (e) {
      setError(errText(e));
    }
  }, [token, errText]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const take = async () => {
    setError(null);
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) { setError(t("selfiePermission")); return; }
    const result = await ImagePicker.launchCameraAsync({
      cameraType: ImagePicker.CameraType.front,
      allowsEditing: false,
      quality: 0.5,
      base64: true,
      mediaTypes: ["images"],
    });
    if (result.canceled || !result.assets || !result.assets[0] || !result.assets[0].base64) return;
    setPhoto(`data:image/jpeg;base64,${result.assets[0].base64}`);
  };

  const send = async () => {
    if (!photo || !status || busy) return;
    setBusy(true);
    setError(null);
    try {
      await submitSelfie(token, photo, status.challenge);
      setDone(true);
      setPhoto(null);
    } catch (e) {
      setError(errText(e));
      if (e && e.code === "CHALLENGE_EXPIRED") { setPhoto(null); load(); } // the code rotated: show the new one
    } finally {
      setBusy(false);
    }
  };

  const notice = selfieNotice(status);

  return (
    <View style={styles.screen}>
      <GradientBackground variant="dark" />
      <ScrollView contentContainerStyle={{ padding: spacing.md, paddingBottom: insets.bottom + spacing.xl }}>
        <Text style={styles.title}>{t("selfieTitle")}</Text>
        <Text style={styles.body}>{t("selfieIntro")}</Text>
        {notice ? <Text style={styles.warn}>{t(notice.key, notice.params)}</Text> : null}
        {!status && !error ? <ActivityIndicator color={colors.amber} style={{ marginTop: spacing.lg }} /> : null}
        {status ? (
          <Card tone="dark" style={{ marginTop: spacing.md }}>
            <Text style={styles.body}>{t("selfieCode")}</Text>
            <Text style={styles.code}>{status.challenge}</Text>
            <Text style={styles.tip}>{t("selfieTip")}</Text>
          </Card>
        ) : null}
        {photo ? <Image source={{ uri: photo }} style={styles.preview} /> : null}
        {done ? <Text style={styles.ok}>{t("selfieSent")}</Text> : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <View style={{ height: spacing.md }} />
        {busy ? (
          <ActivityIndicator color={colors.amber} />
        ) : done ? (
          <Button label="OK" onPress={() => navigation.goBack()} />
        ) : photo ? (
          <>
            <Button label={t("selfieSend")} onPress={send} trailingIcon />
            <View style={{ height: spacing.sm }} />
            <Button label={t("selfieRetake")} variant="ghost" tone="dark" onPress={take} />
          </>
        ) : (
          <Button label={t("selfieTake")} onPress={take} disabled={!status} />
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.ink },
  title: { color: colors.dark.text, fontSize: 22, fontWeight: "800", marginBottom: 6 },
  body: { color: colors.dark.textMuted, fontSize: 14, lineHeight: 20 },
  warn: { color: colors.amber, fontSize: 14, marginTop: spacing.sm },
  code: { color: colors.dark.text, fontSize: 34, fontWeight: "800", letterSpacing: 2, textAlign: "center", marginVertical: spacing.sm },
  tip: { color: colors.dark.textMuted, fontSize: 12.5, textAlign: "center" },
  preview: { width: "100%", height: 320, borderRadius: 16, marginTop: spacing.md, resizeMode: "cover" },
  ok: { color: colors.tealBright, fontSize: 14, marginTop: spacing.md },
  error: { color: colors.coral, fontSize: 13.5, marginTop: spacing.md },
});
