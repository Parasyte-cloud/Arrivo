import React, { useEffect, useRef, useState } from "react";
import { View, Text, StyleSheet, ActivityIndicator, Pressable, ScrollView, Linking, AppState } from "react-native";
import { Card, Button } from "../components/UI";
import { GradientBackground } from "../components/GradientBackground";
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
    securityEscort = false, fleetSize = 0, emergencyContactName, emergencyContactPhone,
  } = route?.params || {};
  const { user, token } = useAuth();

  const [walletBalance, setWalletBalance] = useState(null);
  const [hasMembership, setHasMembership] = useState(false);
  const [loadingOptions, setLoadingOptions] = useState(true);
  const [paymentMethod, setPaymentMethod] = useState("card"); // card | wallet | membership

  const [status, setStatus] = useState("idle"); // idle | opening | verifying | success | error
  const [message, setMessage] = useState(null);
  const [agreedCancellation, setAgreedCancellation] = useState(false);
  const [dashCamConsent, setDashCamConsent] = useState(false);

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
  const pendingPaymentRef = useRef(null); // holds the reference we're waiting to verify once the user returns from the browser

  // expo-web-browser's openAuthSessionAsync would normally tell us the
  // moment the browser closes. Using Linking.openURL (a core React Native
  // API with no Expo config-plugin step at all) instead means we can't get
  // that same signal directly — so we watch for the app itself coming back
  // to the foreground, which happens right when someone switches back from
  // completing (or abandoning) the Paystack checkout in their browser.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      if (nextState === "active" && pendingPaymentRef.current) {
        const reference = pendingPaymentRef.current;
        pendingPaymentRef.current = null;
        verifyAndCreateRide(reference);
      }
    });
    return () => subscription.remove();
  }, []);

  const verifyAndCreateRide = async (reference) => {
    setStatus("verifying");
    try {
      const verification = await verifyPayment(reference);
      if (verification.success) {
        const { ride } = await createRide(token, {
          pickupAddress, stops, flightNumber, vehicleType, fareNaira: amountNaira,
          paymentReference: reference, bookingType, durationDays,
          agreedCancellationPolicy: true, securityEscort, fleetSize, paymentMethod: "card",
          emergencyContactName, emergencyContactPhone, dashCamConsent,
        });
        setStatus("success");
        setTimeout(() => navigation.navigate("Tracking", { rideId: ride.id }), 900);
      } else {
        setStatus("error");
        setMessage(`Payment status: ${verification.status}. If you were charged, contact support with reference ${reference}.`);
      }
    } catch (e) {
      setStatus("error");
      setMessage(e.message || "Something went wrong confirming your payment.");
    }
  };

  const payWithCard = async () => {
    setStatus("opening");
    try {
      const { authorizationUrl, reference } = await initializePayment(user.email, amountNaira);
      pendingPaymentRef.current = reference;
      await Linking.openURL(authorizationUrl);
      // Verification now happens automatically via the AppState listener
      // above once the user switches back to this app from the browser.
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
        emergencyContactName, emergencyContactPhone, dashCamConsent,
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
    if (!dashCamConsent) {
      setMessage("Please agree to the dash cam recording notice before paying.");
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
      <GradientBackground variant="dark" />
      <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingBottom: 40 }}>
        <Text style={styles.title}>Confirm &amp; Pay</Text>

        <Card tone="dark" style={{ marginBottom: spacing.md }}>
          <View style={styles.row}>
            <Text style={styles.label}>{label}</Text>
            <Text style={styles.amount}>{formatNaira(amountNaira)}</Text>
          </View>
        </Card>

        <Card tone="dark" style={{ marginBottom: spacing.md }}>
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
          <Card tone="dark" style={{ marginBottom: spacing.lg }}>
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

        <Pressable onPress={() => setDashCamConsent(!dashCamConsent)} style={styles.agreeRow}>
          <View style={[styles.checkbox, dashCamConsent && styles.checkboxChecked]}>
            {dashCamConsent ? <Text style={styles.checkmark}>✓</Text> : null}
          </View>
          <Text style={styles.agreeText}>
            I agree that this ride may be recorded by an in-vehicle dash cam for safety, and that footage is stored for 30 days and then automatically deleted.
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

        {status === "success" ? <Text style={[styles.statusText, { color: "#8FD9C4" }]}>Confirmed ✓</Text> : null}
        {status === "error" && message ? <Text style={styles.errorText}>{message}</Text> : null}

        <Button
          label={isBusy ? "Please wait…" : `Pay ${formatNaira(amountNaira)}`}
          onPress={pay}
          disabled={isBusy}
          trailingIcon
        />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.dark.bg0 },
  title: { fontSize: 18, fontWeight: "700", color: colors.dark.text, marginBottom: spacing.md },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  label: { color: colors.dark.text, fontSize: 14, fontWeight: "600" },
  amount: { color: colors.amber, fontSize: 18, fontWeight: "700" },
  note: { color: colors.dark.textMuted, fontSize: 12, lineHeight: 18 },
  cardLabel: { color: colors.dark.text, fontWeight: "600", fontSize: 12, marginBottom: 8 },
  payOption: {
    paddingVertical: 10, paddingHorizontal: 12, borderRadius: 10,
    borderWidth: 1, borderColor: colors.dark.surfaceBorder,
  },
  payOptionActive: { borderColor: colors.amber, backgroundColor: "rgba(244,163,0,0.12)" },
  payOptionLabel: { color: colors.dark.text, fontSize: 13, fontWeight: "600" },
  payOptionNote: { color: "#FF9B8A", fontSize: 10.5, marginTop: 4, marginLeft: 14 },
  agreeRow: { flexDirection: "row", alignItems: "flex-start", gap: 10, marginBottom: spacing.lg },
  checkbox: {
    width: 20, height: 20, borderRadius: 5, borderWidth: 1.5, borderColor: colors.dark.surfaceBorder,
    alignItems: "center", justifyContent: "center", marginTop: 1,
  },
  checkboxChecked: { backgroundColor: colors.amber, borderColor: colors.amber },
  checkmark: { color: colors.ink, fontSize: 13, fontWeight: "700" },
  agreeText: { color: colors.dark.textMuted, fontSize: 12, flex: 1 },
  statusText: { color: colors.dark.text, fontSize: 12.5, marginTop: 8, textAlign: "center" },
  errorText: { color: "#FF9B8A", fontSize: 12, marginBottom: spacing.md, textAlign: "center" },
});
