import React, { useState } from "react";
import { View, Text, StyleSheet, ScrollView, TextInput, ActivityIndicator, KeyboardAvoidingView, Platform, Linking, Pressable } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { Card, Button } from "../components/UI";
import { GradientBackground } from "../components/GradientBackground";
import AddressAutocomplete from "../components/AddressAutocomplete";
import PhoneInput from "../components/PhoneInput";
import ServiceSwitcher from "../components/ServiceSwitcher";
import ParasyteSignature from "../components/ParasyteSignature";
import { colors, spacing, radius } from "../theme/tokens";
import { useAuth } from "../context/AuthContext";
import { splitPhone, validatePhone } from "../utils/phoneValidation";
import { createServiceRequest } from "../services/api";
import { messageWithCode } from "../utils/errorRef";
import { REQUEST_SERVICES, goToService } from "../utils/services";

const SUPPORT_PHONE_DIAL = "+2348162706078";

// One screen for Campus, Air, Boat and Removals. The rider says where and when;
// the request goes straight to the drivers who hold that service, and RideArrivo
// confirms the price with the rider before the trip can start.
export default function ServiceRequestScreen({ navigation, route }) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const { token, user } = useAuth();
  const raw = route?.params?.service;
  const service = REQUEST_SERVICES.includes(raw) ? raw : "campus";
  const name = t(`services.${service}`);

  const prefill = route?.params?.prefill || {};
  const [pickup, setPickup] = useState(prefill.pickup?.address || "");
  const [destination, setDestination] = useState(prefill.destination?.address || "");
  // Map points from the address picker, so the job shows on the live map like an ArrivoExpress trip.
  const [pickupPt, setPickupPt] = useState(prefill.pickup?.lat != null ? { lat: prefill.pickup.lat, lng: prefill.pickup.lng } : null);
  const [destPt, setDestPt] = useState(prefill.destination?.lat != null ? { lat: prefill.destination.lat, lng: prefill.destination.lng } : null);
  const [when, setWhen] = useState("");
  const [passengers, setPassengers] = useState("");
  const [details, setDetails] = useState("");
  const [phone, setPhone] = useState(() => splitPhone(user?.phone || user?.whatsapp_number));
  const [ageOk, setAgeOk] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [sent, setSent] = useState(null);

  const submit = async () => {
    setError(null);
    if (pickup.trim().length < 3) return setError(t("services.errPickup"));
    if (destination.trim().length < 3) return setError(t("services.errDestination"));
    let count;
    if (passengers.trim()) {
      count = Number(passengers);
      if (!Number.isInteger(count) || count < 1 || count > 50) return setError(t("services.errPassengers"));
    }
    if (service === "campus" && !ageOk) return setError(t("hub.campusConfirm"));
    const ph = validatePhone(phone.dial, phone.national);
    if (!ph.valid) return setError(ph.message);
    setSending(true);
    try {
      const noteParts = [when.trim() ? `${t("services.when")}: ${when.trim()}` : null, details.trim() || null].filter(Boolean);
      const data = await createServiceRequest(token, {
        service,
        confirmAge16: service === "campus" ? true : undefined,
        pickupAddress: pickup.trim(),
        destinationAddress: destination.trim(),
        pickupLat: pickupPt?.lat, pickupLng: pickupPt?.lng,
        destinationLat: destPt?.lat, destinationLng: destPt?.lng,
        passengerCount: count,
        contactPhone: ph.full,
        details: noteParts.length ? noteParts.join("\n") : undefined,
      });
      setSent({ ...data.ride, contact: ph.full });
    } catch (e) {
      setError(messageWithCode(e, t("services.sendFailed")));
    } finally {
      setSending(false);
    }
  };

  return (
    <View style={styles.screen}>
      <GradientBackground variant="dark" />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 0}>
        <ScrollView contentContainerStyle={{ paddingTop: spacing.md, paddingHorizontal: spacing.lg, paddingBottom: 40 + insets.bottom }} keyboardShouldPersistTaps="handled">
          <Text style={styles.sectionLabel}>{t("services.title")}</Text>
          <ServiceSwitcher current={service} onSelect={(id) => goToService(navigation, id, { replace: true })} />
          <Text style={styles.title}>{t("services.requestTitle", { service: name })}</Text>
          <Text style={styles.meta}>{t(`services.blurb_${service}`)}</Text>

          {sent ? (
            <Card tone="dark" style={{ marginTop: spacing.lg }}>
              <Text style={styles.successTitle}>{t("services.sentTitle")}</Text>
              <Text style={[styles.meta, { marginTop: 6 }]}>{t("services.sentBody", { service: name, id: sent.id, phone: sent.contact })}</Text>
              <Button label={t("services.track")} variant="primary" style={{ marginTop: spacing.md }} onPress={() => navigation.navigate("Tracking", { rideId: sent.id })} />
              <Button label={t("services.another")} variant="ghost" tone="dark" style={{ marginTop: spacing.sm }} onPress={() => { setSent(null); setPickup(""); setDestination(""); setWhen(""); setDetails(""); }} />
            </Card>
          ) : (
            <>
              <Text style={[styles.meta, { marginTop: spacing.md }]}>{t("services.intro")}</Text>
              <Card tone="dark" style={{ marginTop: spacing.md }}>
                <AddressAutocomplete style={{ marginBottom: spacing.sm }} value={pickup} onChangeText={setPickup} onSelect={(p) => setPickupPt(p && p.lat != null ? { lat: p.lat, lng: p.lng } : null)} placeholder={t("services.pickup")} />
                <AddressAutocomplete value={destination} onChangeText={setDestination} onSelect={(p) => setDestPt(p && p.lat != null ? { lat: p.lat, lng: p.lng } : null)} placeholder={t("services.destination")} />
              </Card>
              <Card tone="dark" style={{ marginTop: spacing.md }}>
                <TextInput style={styles.input} value={when} onChangeText={setWhen} placeholder={t("services.when")} placeholderTextColor={colors.dark.textMuted} maxLength={120} />
                <TextInput style={styles.input} value={passengers} onChangeText={setPassengers} placeholder={t("services.passengers")} placeholderTextColor={colors.dark.textMuted} keyboardType="number-pad" />
                <TextInput style={styles.input} value={details} onChangeText={setDetails} placeholder={t("services.details")} placeholderTextColor={colors.dark.textMuted} maxLength={900} multiline />
                <PhoneInput tone="dark" dial={phone.dial} national={phone.national} onChangeDial={(dial) => setPhone((p) => ({ ...p, dial }))} onChangeNational={(national) => setPhone((p) => ({ ...p, national }))} placeholder={t("services.phone")} />
                {service === "campus" ? (
                  <Pressable onPress={() => setAgeOk((v) => !v)} style={styles.confirmRow} accessibilityRole="checkbox" accessibilityState={{ checked: ageOk }}>
                    <View style={[styles.box, ageOk && styles.boxOn]}>{ageOk ? <Text style={styles.tick}>✓</Text> : null}</View>
                    <Text style={[styles.meta, { flex: 1 }]}>{t("hub.campusConfirm")}</Text>
                  </Pressable>
                ) : null}
                <Text style={[styles.meta, { marginBottom: spacing.sm }]}>{t("services.pricePendingLong")}</Text>
                {error ? <Text style={styles.errorText}>{error}</Text> : null}
                {sending ? <ActivityIndicator color={colors.amber} style={{ marginTop: spacing.sm }} /> : <Button label={t("services.send")} variant="primary" onPress={submit} />}
              </Card>
              <Pressable style={styles.whatsappRow} onPress={() => Linking.openURL(`https://wa.me/${SUPPORT_PHONE_DIAL.replace("+", "")}`).catch(() => {})}>
                <Text style={styles.whatsappText}>{t("onTheGo.ratherJustTalkToSomeone")}</Text>
              </Pressable>
            </>
          )}
          <ParasyteSignature />
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.dark.bg0 },
  sectionLabel: { color: colors.dark.textMuted, fontSize: 11.5, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.6 },
  title: { fontSize: 19, fontWeight: "700", color: colors.dark.text, marginTop: spacing.sm, marginBottom: 4 },
  meta: { color: colors.dark.textMuted, fontSize: 12.5, lineHeight: 18 },
  successTitle: { color: colors.dark.text, fontSize: 14, fontWeight: "700" },
  errorText: { color: "#C2362B", fontSize: 11.5, marginTop: 4, marginBottom: 8 },
  input: { backgroundColor: colors.dark.fieldBg, color: colors.dark.text, borderRadius: radius.sm + 2, paddingHorizontal: spacing.md, paddingVertical: 12, fontSize: 13, marginBottom: spacing.sm },
  confirmRow: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: spacing.sm },
  box: { width: 22, height: 22, borderRadius: 6, borderWidth: 1.5, borderColor: colors.dark.textMuted, alignItems: "center", justifyContent: "center" },
  boxOn: { backgroundColor: colors.amber, borderColor: colors.amber },
  tick: { color: colors.ink, fontWeight: "800", fontSize: 14 },
  whatsappRow: { marginTop: spacing.lg, alignItems: "center" },
  whatsappText: { color: colors.tealBright, fontSize: 12.5, fontWeight: "600" },
});
