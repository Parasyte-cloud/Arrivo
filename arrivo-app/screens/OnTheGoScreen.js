import React, { useState } from "react";
import { messageWithCode } from "../utils/errorRef";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Linking,
  Pressable,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Card, Button } from "../components/UI";
import { GradientBackground } from "../components/GradientBackground";
import AddressAutocomplete from "../components/AddressAutocomplete";
import PhoneInput from "../components/PhoneInput";
import { colors, spacing, radius } from "../theme/tokens";
import { useAuth } from "../context/AuthContext";
import { splitPhone, validatePhone } from "../utils/phoneValidation";
import { createOnTheGoRequest } from "../services/api";
import { formatLagos } from "../utils/lagosTime";
import { useTranslation } from "react-i18next";
import { whatsappUrl } from "../utils/supportContacts";

// The short path for someone flying in within about 3 hours who hasn't got
// time for the full Plan Route flow. Essentials only: where from, where to,
// flight if they have one, how many of them, and a number we can ring.
// No vehicle picker, no escort or fleet options, and no payment step. Ops
// confirms a driver and takes payment then, which is the whole point of it
// being quicker.
export default function OnTheGoScreen({ navigation, route }) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const { token, user } = useAuth();

  // Arrives filled in when the rider got here from a booking that was too close
  // for the standard flow (see components/BookingWindowNotice.js), so nothing
  // they typed there has to be typed again.
  const prefill = route?.params?.prefill || null;
  const [pickup, setPickup] = useState(prefill?.pickupAddress || "");
  const [destination, setDestination] = useState(prefill?.destinationAddress || "");
  const [flightNumber, setFlightNumber] = useState(prefill?.flightNumber || "");
  const [passengers, setPassengers] = useState(String(prefill?.passengerCount || 1));
  const [details, setDetails] = useState(prefill?.details || "");
  const requestedPickupAt = prefill?.requestedPickupAt || null;
  // Prefilled from their profile so most people just tap send.
  const [phone, setPhone] = useState(() => splitPhone(user?.phone || user?.whatsapp_number));
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [sent, setSent] = useState(null);

  const submit = async () => {
    setError(null);
    if (!pickup.trim()) {
      setError(t("onTheGo.errPickup"));
      return;
    }
    if (!destination.trim()) {
      setError(t("onTheGo.errDestination"));
      return;
    }
    const count = Number(passengers);
    if (!Number.isInteger(count) || count < 1) {
      setError(t("onTheGo.errPassengers"));
      return;
    }
    const phoneResult = validatePhone(phone.dial, phone.national);
    if (!phoneResult.valid) {
      setError(phoneResult.message);
      return;
    }

    setSending(true);
    try {
      const data = await createOnTheGoRequest(token, {
        pickupAddress: pickup.trim(),
        destinationAddress: destination.trim(),
        flightNumber: flightNumber.trim() || undefined,
        passengerCount: count,
        contactPhone: phoneResult.full,
        requestedPickupAt: requestedPickupAt || undefined,
        details: details.trim() || undefined,
        service: prefill?.service || undefined,
      });
      setSent(data.request);
    } catch (e) {
      setError(messageWithCode(e, "Couldn't send that. Please try again, or reach us on WhatsApp."));
    } finally {
      setSending(false);
    }
  };

  return (
    <View style={styles.screen}>
      <GradientBackground variant="dark" />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 0}
      >
        <ScrollView
          contentContainerStyle={{
            paddingTop: insets.top + spacing.lg,
            paddingHorizontal: spacing.lg,
            paddingBottom: 40,
          }}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={styles.title}>{t("onTheGo.onTheGo")}</Text>
          <Text style={styles.meta}>
            {t("onTheGo.travellingSoonAndShortOn")}
          </Text>

          {sent ? (
            <Card tone="dark" style={{ marginTop: spacing.lg }}>
              <Text style={styles.successTitle}>{t("onTheGo.weReOnIt")}</Text>
              <Text style={[styles.meta, { marginTop: 6 }]}>
                {t("onTheGo.requestWithTeam", { id: sent.id })}{requestedPickupAt ? ` ${t("onTheGo.youAskedFor", { time: formatLagos(requestedPickupAt) })}` : ""} {t("onTheGo.weWillRing", { phone: sent.contact_phone })}
              </Text>
              <Button
                label={t("onTheGo.messageUsOnWhatsapp")}
                variant="ghost"
                tone="dark"
                style={{ marginTop: spacing.md }}
                onPress={() =>
                  Linking.openURL(whatsappUrl()).catch(() => {})
                }
              />
            </Card>
          ) : (
            <>
              <Card tone="dark" style={{ marginTop: spacing.lg }}>
                <Text style={styles.cardLabel}>{t("onTheGo.whereTo")}</Text>
                <AddressAutocomplete
                  style={{ marginBottom: spacing.sm }}
                  value={pickup}
                  onChangeText={setPickup}
                  onSelect={() => {}}
                  placeholder={t("onTheGo.enterPickupAddress")}
                />
                <AddressAutocomplete
                  value={destination}
                  onChangeText={setDestination}
                  onSelect={() => {}}
                  placeholder={t("onTheGo.enterDestination")}
                />
              </Card>

              <Card tone="dark" style={{ marginTop: spacing.md }}>
                <Text style={styles.cardLabel}>{t("onTheGo.yourDetails")}</Text>
                {requestedPickupAt ? (
                  <Text style={[styles.meta, { marginBottom: spacing.sm }]}>
                    Time you asked for: {formatLagos(requestedPickupAt)}
                  </Text>
                ) : null}
                <TextInput
                  style={styles.input}
                  value={flightNumber}
                  onChangeText={setFlightNumber}
                  placeholder={t("onTheGo.flightNumberOptional")}
                  placeholderTextColor={colors.dark.textMuted}
                  autoCapitalize="characters"
                />
                <TextInput
                  style={styles.input}
                  value={passengers}
                  onChangeText={setPassengers}
                  placeholder={t("onTheGo.passengers")}
                  placeholderTextColor={colors.dark.textMuted}
                  keyboardType="number-pad"
                />
                <TextInput
                  style={styles.input}
                  value={details}
                  onChangeText={setDetails}
                  placeholder={t("onTheGo.anythingWeShouldKnowOptional")}
                  placeholderTextColor={colors.dark.textMuted}
                  maxLength={1000}
                  multiline
                />
                <PhoneInput
                  tone="dark"
                  dial={phone.dial}
                  national={phone.national}
                  onChangeDial={(dial) => setPhone((p) => ({ ...p, dial }))}
                  onChangeNational={(national) => setPhone((p) => ({ ...p, national }))}
                  placeholder={t("onTheGo.contactNumber")}
                />

                {error ? <Text style={styles.errorText}>{error}</Text> : null}
                {sending ? (
                  <ActivityIndicator color={colors.amber} style={{ marginTop: spacing.sm }} />
                ) : (
                  <Button label={t("onTheGo.sendRequest")} variant="primary" onPress={submit} />
                )}
              </Card>

              <Pressable
                style={styles.whatsappRow}
                onPress={() =>
                  Linking.openURL(whatsappUrl()).catch(() => {})
                }
              >
                <Text style={styles.whatsappText}>{t("onTheGo.ratherJustTalkToSomeone")}</Text>
              </Pressable>
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.dark.bg0 },
  title: { fontSize: 19, fontWeight: "700", color: colors.dark.text, marginBottom: spacing.sm },
  meta: { color: colors.dark.textMuted, fontSize: 12.5, lineHeight: 18 },
  cardLabel: { color: colors.dark.text, fontWeight: "600", fontSize: 12, marginBottom: 10 },
  successTitle: { color: colors.dark.text, fontSize: 14, fontWeight: "700" },
  errorText: { color: "#C2362B", fontSize: 11.5, marginTop: 4, marginBottom: 8 },
  input: {
    backgroundColor: colors.dark.fieldBg,
    color: colors.dark.text,
    borderRadius: radius.sm + 2,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    fontSize: 13,
    marginBottom: spacing.sm,
  },
  whatsappRow: { marginTop: spacing.lg, alignItems: "center" },
  whatsappText: { color: colors.tealBright, fontSize: 12.5, fontWeight: "600" },
});
