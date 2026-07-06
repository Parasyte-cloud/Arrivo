import React, { useState } from "react";
import { View, Text, StyleSheet, ActivityIndicator, Alert } from "react-native";
import * as WebBrowser from "expo-web-browser";
import { Card, Button } from "../components/UI";
import { colors, spacing } from "../theme/tokens";
import { initializePayment, verifyPayment, createRide } from "../services/api";
import { useAuth } from "../context/AuthContext";

export default function CheckoutScreen({ route, navigation }) {
  const { amountNaira = 12500, label = "Airport Pickup", pickupAddress = "Murtala Muhammed Airport", stops = [], flightNumber, vehicleType } =
    route?.params || {};
  const { user, token } = useAuth();
  const [status, setStatus] = useState("idle"); // idle | opening | verifying | success | error
  const [message, setMessage] = useState(null);

  const pay = async () => {
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
        await createRide(token, {
          pickupAddress,
          stops,
          flightNumber,
          vehicleType,
          fareNaira: amountNaira,
          paymentReference: reference,
        });
        setStatus("success");
        setTimeout(() => navigation.navigate("Tracking"), 900);
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
  statusText: { color: colors.cream, fontSize: 12.5, marginTop: 8, textAlign: "center" },
  errorText: { color: colors.coral, fontSize: 12, marginBottom: spacing.md, textAlign: "center" },
});
