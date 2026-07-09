import React, { useState } from "react";
import { View, Text, StyleSheet, ActivityIndicator, Alert, Pressable } from "react-native";
import * as WebBrowser from "expo-web-browser";
import { Card, Button } from "../components/UI";
import { colors, spacing } from "../theme/tokens";
import { initializePayment, verifyPayment, createRide } from "../services/api";
import { useAuth } from "../context/AuthContext";

export default function CheckoutScreen({ route, navigation }) {
  const {
    amountNaira = 12500, label = "Airport Pickup", pickupAddress = "Murtala Muhammed Airport",
    stops = [], flightNumber, vehicleType, bookingType = "one_way", durationDays = 1,
  } = route?.params || {};
  const { user, token } = useAuth();
  const [status, setStatus] = useState("idle"); // idle | opening | verifying | success | error
  const [message, setMessage] = useState(null);
  const [agreedCancellation, setAgreedCancellation] = useState(false);

  const pay = async () => {
    if (!agreedCancellation) {
      setMessage("Please agree to the Cancellation & Refund Policy before paying.");
      setStatus("error");
      return;
    }

    setStatus("opening");
    setMessage(null);
    try {
      const { authorizationUrl, reference } = await initializePayment(user.email, amountNaira);

      const result = await WebBrowser.openAuthSessionAsync(authorizationUrl, undefined);
      // openAuthSessionAsync resolves once the browser closes (success, cancel, or dismiss).

      if (result.type !== "success" && result.type !== "dismiss") {
        setStatus("idle");
        return;
      }

      setStatus("verifying");
      const verification = await verifyPayment(reference);

      if (verification.success) {
        // Persist the ride now that payment is confirmed.
        const { ride } = await createRide(token, {
          pickupAddress,
          stops,
          flightNumber,
          vehicleType,
          fareNaira: amountNaira,
          paymentReference: reference,
          bookingType,
          durationDays,
          agreedCancellationPolicy: true,
        });
        setStatus("success");
        setTimeout(() => navigation.navigate("Tracking", { rideId: ride.id }), 900);
      } else {
        setStatus("error");
        setMessage(`Payment status: ${verification.status}. If you were charged, contact support with reference ${reference}.`);
      }
    } catch (e) {
      setStatus("error");
      setMessage(e.message || "Something went wrong starting the payment.");
    }
  };

  return (
    <View style={styles.screen}>
      <View style={{ padding: spacing.lg }}>
        <Text style={styles.title}>Confirm & Pay</Text>

        <Card style={{ marginBottom: spacing.md }}>
          <View style={styles.row}>
            <Text style={styles.label}>{label}</Text>
            <Text style={styles.amount}>₦{amountNaira.toLocaleString()}</Text>
          </View>
        </Card>

        <Card style={{ marginBottom: spacing.lg }}>
          <Text style={styles.note}>
            Payment is handled by Paystack's secure checkout — Arrivo never sees or stores your card details.
          </Text>
        </Card>

        <Pressable onPress={() => setAgreedCancellation(!agreedCancellation)} style={styles.agreeRow}>
          <View style={[styles.checkbox, agreedCancellation && styles.checkboxChecked]}>
            {agreedCancellation ? <Text style={styles.checkmark}>✓</Text> : null}
          </View>
          <Text style={styles.agreeText}>
            I agree to Arrivo's Cancellation &amp; Refund Policy (48-hour free cancellation, 50% refund after).
          </Text>
        </Pressable>

        {status === "opening" || status === "verifying" ? (
          <View style={{ alignItems: "center", paddingVertical: spacing.md }}>
            <ActivityIndicator color={colors.amber} />
            <Text style={styles.statusText}>
              {status === "opening" ? "Opening secure checkout…" : "Confirming your payment…"}
            </Text>
          </View>
        ) : null}

        {status === "success" ? <Text style={[styles.statusText, { color: colors.tealBright }]}>Payment confirmed ✓</Text> : null}
        {status === "error" && message ? <Text style={styles.errorText}>{message}</Text> : null}

        <Button
          label={status === "opening" || status === "verifying" ? "Please wait…" : `Pay ₦${amountNaira.toLocaleString()}`}
          onPress={pay}
          disabled={status === "opening" || status === "verifying"}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.ink },
  title: { fontSize: 18, fontWeight: "700", color: colors.cream, marginBottom: spacing.md },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  label: { color: colors.cream, fontSize: 14, fontWeight: "600" },
  amount: { color: colors.amber, fontSize: 18, fontWeight: "700" },
  note: { color: colors.textMuted, fontSize: 12, lineHeight: 18 },
  agreeRow: { flexDirection: "row", alignItems: "flex-start", gap: 10, marginBottom: spacing.lg },
  checkbox: {
    width: 20, height: 20, borderRadius: 5, borderWidth: 1.5, borderColor: "rgba(255,255,255,0.35)",
    alignItems: "center", justifyContent: "center", marginTop: 1,
  },
  checkboxChecked: { backgroundColor: colors.amber, borderColor: colors.amber },
  checkmark: { color: colors.ink, fontSize: 13, fontWeight: "700" },
  agreeText: { color: colors.textMuted, fontSize: 12, flex: 1 },
  statusText: { color: colors.cream, fontSize: 12.5, marginTop: 8, textAlign: "center" },
  errorText: { color: colors.coral, fontSize: 12, marginBottom: spacing.md, textAlign: "center" },
});
