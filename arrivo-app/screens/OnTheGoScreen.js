import React, { useState } from "react";
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

const SUPPORT_PHONE_DIAL = "+2348162706078";

// The short path for someone flying in within about 12 hours who hasn't got
// time for the full Plan Route flow. Essentials only: where from, where to,
// flight if they have one, how many of them, and a number we can ring.
// No vehicle picker, no escort or fleet options, and no payment step. Ops
// confirms a driver and takes payment then, which is the whole point of it
// being quicker.
export default function OnTheGoScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const { token, user } = useAuth();

  const [pickup, setPickup] = useState("");
  const [destination, setDestination] = useState("");
  const [flightNumber, setFlightNumber] = useState("");
  const [passengers, setPassengers] = useState("1");
  // Prefilled from their profile so most people just tap send.
  const [phone, setPhone] = useState(() => splitPhone(user?.phone || user?.whatsapp_number));
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [sent, setSent] = useState(null);

  const submit = async () => {
    setError(null);
    if (!pickup.trim()) {
      setError("Where are we picking you up?");
      return;
    }
    if (!destination.trim()) {
      setError("Where are you heading?");
      return;
    }
    const count = Number(passengers);
    if (!Number.isInteger(count) || count < 1) {
      setError("How many people are travelling?");
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
      });
      setSent(data.request);
    } catch (e) {
      setError(e.message || "Couldn't send that. Please try again, or reach us on WhatsApp.");
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
          <Text style={styles.title}>On the Go</Text>
          <Text style={styles.meta}>
            Travelling soon and short on time? Give us the basics and we'll call you back to confirm
            a driver. No payment needed up front.
          </Text>

          {sent ? (
            <Card tone="dark" style={{ marginTop: spacing.lg }}>
              <Text style={styles.successTitle}>We're on it</Text>
              <Text style={[styles.meta, { marginTop: 6 }]}>
                Request #{sent.id} is with our team. We'll ring {sent.contact_phone} shortly to
                confirm your driver and sort payment.
              </Text>
              <Button
                label="Message us on WhatsApp"
                variant="ghost"
                tone="dark"
                style={{ marginTop: spacing.md }}
                onPress={() =>
                  Linking.openURL(`https://wa.me/${SUPPORT_PHONE_DIAL.replace("+", "")}`).catch(() => {})
                }
              />
            </Card>
          ) : (
            <>
              <Card tone="dark" style={{ marginTop: spacing.lg }}>
                <Text style={styles.cardLabel}>Where to?</Text>
                <AddressAutocomplete
                  style={{ marginBottom: spacing.sm }}
                  value={pickup}
                  onChangeText={setPickup}
                  onSelect={() => {}}
                  placeholder="Enter pickup address"
                />
                <AddressAutocomplete
                  value={destination}
                  onChangeText={setDestination}
                  onSelect={() => {}}
                  placeholder="Enter destination"
                />
              </Card>

              <Card tone="dark" style={{ marginTop: spacing.md }}>
                <Text style={styles.cardLabel}>Your details</Text>
                <TextInput
                  style={styles.input}
                  value={flightNumber}
                  onChangeText={setFlightNumber}
                  placeholder="Flight number (optional)"
                  placeholderTextColor={colors.dark.textMuted}
                  autoCapitalize="characters"
                />
                <TextInput
                  style={styles.input}
                  value={passengers}
                  onChangeText={setPassengers}
                  placeholder="Passengers"
                  placeholderTextColor={colors.dark.textMuted}
                  keyboardType="number-pad"
                />
                <PhoneInput
                  tone="dark"
                  dial={phone.dial}
                  national={phone.national}
                  onChangeDial={(dial) => setPhone((p) => ({ ...p, dial }))}
                  onChangeNational={(national) => setPhone((p) => ({ ...p, national }))}
                  placeholder="Contact number"
                />

                {error ? <Text style={styles.errorText}>{error}</Text> : null}
                {sending ? (
                  <ActivityIndicator color={colors.amber} style={{ marginTop: spacing.sm }} />
                ) : (
                  <Button label="Send request" variant="primary" onPress={submit} />
                )}
              </Card>

              <Pressable
                style={styles.whatsappRow}
                onPress={() =>
                  Linking.openURL(`https://wa.me/${SUPPORT_PHONE_DIAL.replace("+", "")}`).catch(() => {})
                }
              >
                <Text style={styles.whatsappText}>Rather just talk to someone? Message us on WhatsApp</Text>
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
  errorText: { color: "#FF9B8A", fontSize: 11.5, marginTop: 4, marginBottom: 8 },
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
