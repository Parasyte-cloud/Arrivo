import React, { useEffect, useState } from "react";
import { View, Text, StyleSheet, ActivityIndicator, Pressable, ScrollView } from "react-native";
import * as WebBrowser from "expo-web-browser";
import { Card, Button } from "../components/UI";
import { colors, spacing } from "../theme/tokens";
import { initializePayment, verifyPayment, createRide, getWallet, getMembership } from "../services/api";
import { useAuth } from "../context/AuthContext";

function formatNaira(amount) {
  return "₦" + Number(amount || 0).toLocaleString();
}

export default function CheckoutScreen({ route, navigation }) {
  const {
    amountNaira = 12500, label = "Airport Pickup", pickupAddress = "Murtala Muhammed Airport",
    stops = [], flightNumber, vehicleType, bookingType = "one_way", durationDays = 1,
    securityEscort = false, fleetSize = 0,
  } = route?.params || {};
  const { user, token } = useAuth();

  const [walletBalance, setWalletBalance] = useState(null);
  const [hasMembership, setHasMembership] = useState(false);
  const [loadingOptions, setLoadingOptions] = useState(true);
  const [paymentMethod, setPaymentMethod] = useState("card"); // card | wallet | membership

  const [status, setStatus] = useState("idle"); // idle | opening | verifying | success | error
  const [message, setMessage] = useState(null);
  const [agreedCancellation, setAgreedCancellation] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [wallet, membership] = await Promise.all([getWallet(token), getMembership(token)]);
        setWalletBalance(wallet.balanceNaira);
        setHasMembership(!!membership.membership);
        // Default to whichever payment method is genuinely usable, so
        // someone with an active membership or enough wallet balance
        // isn't stuck manually switching off "card" every time.
        if (membership.membership) setPaymentMethod("membership");
        else if (wallet.balanceNaira >= amountNaira) setPaymentMethod("wallet");
      } catch (e) {
        // Payment options are a convenience layer on top of card payment,
        // which always works — a failed lookup here shouldn't block
        // checkout, just leave the rider on the card option.
      } finally {
        setLoadingOptions(false);
      }
    })();
  }, [token, amountNaira]);

  const walletSufficient = walletBalance != null && walletBalance >= amountNaira;

  const payWithCard = async () => {
    setStatus("opening");
    try {
      const { authorizationUrl, reference } = await initializePayment(user.email, amountNaira);
      const result = await WebBrowser.openAuthSessionAsync(authorizationUrl, undefined);

      if (result.type !== "success" && result.type !== "dismiss") {
        setStatus("idle");
        return;
      }

      setStatus("verifying");
      const verification = await verifyPayment(reference);

      if (verification.success) {
        const { ride } = await createRide(token, {
          pickupAddress, stops, flightNumber, vehicleType, fareNaira: amountNaira,
          paymentReference: reference, bookingType, durationDays,
          agreedCancellationPolicy: true, securityEscort, fleetSize, paymentMethod: "card",
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

  const payWithWalletOrMembership = async () => {
    setStatus("verifying");
    try {
      const { ride } = await createRide(token, {
        pickupAddress, stops, flightNumber, vehicleType, fareNaira: amountNaira,
        bookingType, durationDays, agreedCancellationPolicy: true,
        securityEscort, fleetSize, paymentMethod,
      });
      setStatus("success");
      setTimeout(() => navigation.navigate("Tracking", { rideId: ride.id }), 900);
    } catch (e) {
      setStatus("error");
      setMessage(e.message || "Something went wrong confirming your ride.");
    }
  };

  const pay = () => {
    if (!agreedCancellation) {
      setMessage("Please agree to the Cancellation & Refund Policy before paying.");
      setStatus("error");
      return;
    }
    setMessage(null);
    if (paymentMethod === "card") payWithCard();
    else payWithWalletOrMembership();
  };

  const isBusy = status === "opening" || status === "verifying";

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingBottom: 40 }}>
        <Text style={styles.title}>Confirm &amp; Pay</Text>

        <Card style={{ marginBottom: spacing.md }}>
          <View style={styles.row}>
            <Text style={styles.label}>{label}</Text>
            <Text style={styles.amount}>{formatNaira(amountNaira)}</Text>
          </View>
        </Card>

        <Card style={{ marginBottom: spacing.md }}>
          <Text style={styles.cardLabel}>How would you like to pay?</Text>
          {loadingOptions ? (
            <ActivityIndicator color={colors.amber} style={{ marginVertical: spacing.sm }} />
          ) : (
            <View style={{ gap: 8 }}>
              <Pressable
                onPress={() => setPaymentMethod("card")}
                style={[styles.payOption, paymentMethod === "card" && styles.payOptionActive]}
              >
                <Text style={styles.payOptionLabel}>{paymentMethod === "card" ? "● " : "○ "}Card (Paystack)</Text>
              </Pressable>
              <Pressable
                onPress={() => walletSufficient && setPaymentMethod("wallet")}
                disabled={!walletSufficient}
                style={[styles.payOption, paymentMethod === "wallet" && styles.payOptionActive, !walletSufficient && { opacity: 0.4 }]}
              >
                <Text style={styles.payOptionLabel}>
                  {paymentMethod === "wallet" ? "● " : "○ "}Wallet balance{walletBalance != null ? ` (${formatNaira(walletBalance)})` : ""}
                </Text>
                {!walletSufficient && walletBalance != null ? (
                  <Text style={styles.payOptionNote}>Not enough balance for this fare</Text>
                ) : null}
              </Pressable>
              {hasMembership ? (
                <Pressable
                  onPress={() => setPaymentMethod("membership")}
                  style={[styles.payOption, paymentMethod === "membership" && styles.payOptionActive]}
                >
                  <Text style={styles.payOptionLabel}>{paymentMethod === "membership" ? "● " : "○ "}Membership (no charge)</Text>
                </Pressable>
              ) : null}
            </View>
          )}
        </Card>

        {paymentMethod === "card" ? (
          <Card style={{ marginBottom: spacing.lg }}>
            <Text style={styles.note}>
              Payment is handled by Paystack's secure checkout. RideArrivo never sees or stores your card details.
            </Text>
          </Card>
        ) : null}

        <Pressable onPress={() => setAgreedCancellation(!agreedCancellation)} style={styles.agreeRow}>
          <View style={[styles.checkbox, agreedCancellation && styles.checkboxChecked]}>
            {agreedCancellation ? <Text style={styles.checkmark}>✓</Text> : null}
          </View>
          <Text style={styles.agreeText}>
            I agree to RideArrivo's Cancellation &amp; Refund Policy (48-hour free cancellation, 50% refund after).
          </Text>
        </Pressable>

        {isBusy ? (
          <View style={{ alignItems: "center", paddingVertical: spacing.md }}>
            <ActivityIndicator color={colors.amber} />
            <Text style={styles.statusText}>
              {status === "opening" ? "Opening secure checkout…" : "Confirming your ride…"}
            </Text>
          </View>
        ) : null}

        {status === "success" ? <Text style={[styles.statusText, { color: colors.tealBright }]}>Confirmed ✓</Text> : null}
        {status === "error" && message ? <Text style={styles.errorText}>{message}</Text> : null}

        <Button
          label={isBusy ? "Please wait…" : `Pay ${formatNaira(amountNaira)}`}
          onPress={pay}
          disabled={isBusy}
        />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  title: { fontSize: 18, fontWeight: "700", color: colors.ink, marginBottom: spacing.md },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  label: { color: colors.ink, fontSize: 14, fontWeight: "600" },
  amount: { color: colors.amber, fontSize: 18, fontWeight: "700" },
  note: { color: colors.textMuted, fontSize: 12, lineHeight: 18 },
  cardLabel: { color: colors.ink, fontWeight: "600", fontSize: 12, marginBottom: 8 },
  payOption: {
    paddingVertical: 10, paddingHorizontal: 12, borderRadius: 10,
    borderWidth: 1, borderColor: "rgba(18,18,59,0.15)",
  },
  payOptionActive: { borderColor: colors.amber, backgroundColor: "rgba(244,163,0,0.08)" },
  payOptionLabel: { color: colors.ink, fontSize: 13, fontWeight: "600" },
  payOptionNote: { color: colors.coral, fontSize: 10.5, marginTop: 4, marginLeft: 14 },
  agreeRow: { flexDirection: "row", alignItems: "flex-start", gap: 10, marginBottom: spacing.lg },
  checkbox: {
    width: 20, height: 20, borderRadius: 5, borderWidth: 1.5, borderColor: "rgba(18,18,59,0.35)",
    alignItems: "center", justifyContent: "center", marginTop: 1,
  },
  checkboxChecked: { backgroundColor: colors.amber, borderColor: colors.amber },
  checkmark: { color: colors.ink, fontSize: 13, fontWeight: "700" },
  agreeText: { color: colors.textMuted, fontSize: 12, flex: 1 },
  statusText: { color: colors.ink, fontSize: 12.5, marginTop: 8, textAlign: "center" },
  errorText: { color: colors.coral, fontSize: 12, marginBottom: spacing.md, textAlign: "center" },
});
