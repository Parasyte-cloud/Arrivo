import React, { useCallback, useState } from "react";
import { View, Text, StyleSheet, ScrollView, ActivityIndicator, TextInput } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { Card, Button, Tag } from "../components/UI";
import { GradientBackground } from "../components/GradientBackground";
import { colors, spacing } from "../theme/tokens";
import { useAuth } from "../context/AuthContext";
import {
  getMembership, getWallet, subscribeIndividualMembership,
  subscribeCorporateMembership, linkCorporateDelegate,
} from "../services/api";

function formatNaira(amount) {
  return "₦" + Number(amount || 0).toLocaleString();
}

function formatDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export default function MembershipScreen({ navigation }) {
  const { token } = useAuth();
  const [membership, setMembership] = useState(null);
  const [delegateCount, setDelegateCount] = useState(0);
  const [walletBalance, setWalletBalance] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [delegateEmail, setDelegateEmail] = useState("");
  const [linkStatus, setLinkStatus] = useState(null);

  const load = useCallback(async () => {
    try {
      const [m, w] = await Promise.all([getMembership(token), getWallet(token)]);
      setMembership(m.membership);
      setDelegateCount(m.delegateCount || 0);
      setWalletBalance(w.balanceNaira);
    } catch (e) {
      setError(e.message || "Couldn't load membership details.");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const subscribeIndividual = async () => {
    setBusy(true);
    setError(null);
    try {
      await subscribeIndividualMembership(token);
      await load();
    } catch (e) {
      setError(e.message || "Couldn't subscribe. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const subscribeCorporate = async () => {
    setBusy(true);
    setError(null);
    try {
      await subscribeCorporateMembership(token);
      await load();
    } catch (e) {
      setError(e.message || "Couldn't subscribe. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const addDelegate = async () => {
    if (!delegateEmail.trim()) return;
    setLinkStatus("busy");
    setError(null);
    try {
      await linkCorporateDelegate(token, delegateEmail.trim().toLowerCase());
      setDelegateEmail("");
      setLinkStatus("success");
      await load();
    } catch (e) {
      setLinkStatus(null);
      setError(e.message || "Couldn't link that delegate.");
    }
  };

  if (loading) {
    return (
      <View style={styles.screen}>
        <GradientBackground variant="dark" />
        <View style={[StyleSheet.absoluteFill, { alignItems: "center", justifyContent: "center" }]}>
          <ActivityIndicator color={colors.amber} size="large" />
        </View>
      </View>
    );
  }

  const isCorporate = membership?.plan_type === "corporate_delegate" && !membership?.company_account_id;
  const isCorporateDelegate = membership?.plan_type === "corporate_delegate" && !!membership?.company_account_id;
  const isIndividual = membership?.plan_type === "individual_annual";

  return (
    <View style={styles.screen}>
      <GradientBackground variant="dark" />
      <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingBottom: 40 }}>
        <Text style={styles.title}>Membership</Text>

        {error ? <Text style={styles.errorText}>{error}</Text> : null}

        {membership ? (
          <Card tone="dark" tinted style={{ marginBottom: spacing.md }}>
            <View style={styles.rowBetween}>
              <Text style={styles.planName}>
                {isCorporateDelegate ? "Corporate delegate" : isCorporate ? "Corporate (company account)" : "Individual annual"}
              </Text>
              <Tag label="Active" tone="teal" />
            </View>
            <Text style={styles.meta}>
              {isCorporateDelegate ? "Rides billed to your company." : "No per-trip charge until this expires."}
            </Text>
            <Text style={styles.meta}>Renews / expires {formatDate(membership.expires_at)}</Text>
          </Card>
        ) : (
          <Card tone="dark" style={{ marginBottom: spacing.md }}>
            <Text style={styles.meta}>No active membership yet.</Text>
          </Card>
        )}

        {!membership ? (
          <>
            <Card tone="dark" style={{ marginBottom: spacing.md }}>
              <Text style={styles.cardLabel}>Individual annual</Text>
              <Text style={styles.price}>{formatNaira(250000)}/year</Text>
              <Text style={styles.meta}>Ride without paying per trip. Billed from your wallet balance.</Text>
              {walletBalance != null && walletBalance < 250000 ? (
                <Text style={styles.warningText}>
                  Wallet balance is {formatNaira(walletBalance)} — top up at least {formatNaira(250000 - walletBalance)} more to subscribe.
                </Text>
              ) : null}
              <View style={{ height: spacing.sm }} />
              {busy ? (
                <ActivityIndicator color={colors.amber} />
              ) : (
                <Button
                  label="Subscribe"
                  variant="ghost"
                  tone="dark"
                  onPress={subscribeIndividual}
                  disabled={walletBalance == null || walletBalance < 250000}
                />
              )}
            </Card>

            <Card tone="dark" style={{ marginBottom: spacing.md }}>
              <Text style={styles.cardLabel}>Corporate</Text>
              <Text style={styles.price}>{formatNaira(1500000)}/year</Text>
              <Text style={styles.meta}>Link your team as delegates — their rides bill to your company account.</Text>
              {walletBalance != null && walletBalance < 1500000 ? (
                <Text style={styles.warningText}>
                  Wallet balance is {formatNaira(walletBalance)} — top up at least {formatNaira(1500000 - walletBalance)} more to subscribe.
                </Text>
              ) : null}
              <View style={{ height: spacing.sm }} />
              {busy ? (
                <ActivityIndicator color={colors.amber} />
              ) : (
                <Button
                  label="Subscribe as a company"
                  variant="ghost"
                  tone="dark"
                  onPress={subscribeCorporate}
                  disabled={walletBalance == null || walletBalance < 1500000}
                />
              )}
            </Card>
          </>
        ) : null}

        {isCorporate ? (
          <Card tone="dark" style={{ marginBottom: spacing.md }}>
            <Text style={styles.cardLabel}>Delegates ({delegateCount})</Text>
            <Text style={styles.meta}>Add a teammate by the email they used to sign up for RideArrivo.</Text>
            <View style={{ height: spacing.sm }} />
            <TextInput
              style={styles.input}
              placeholder="teammate@company.com"
              placeholderTextColor={colors.dark.textMuted}
              value={delegateEmail}
              onChangeText={setDelegateEmail}
              autoCapitalize="none"
              keyboardType="email-address"
            />
            <View style={{ height: spacing.sm }} />
            {linkStatus === "busy" ? (
              <ActivityIndicator color={colors.amber} />
            ) : (
              <Button label="Add delegate" variant="ghost" tone="dark" onPress={addDelegate} />
            )}
            {linkStatus === "success" ? <Text style={styles.successText}>Delegate added ✓</Text> : null}
          </Card>
        ) : null}

        {walletBalance != null ? (
          <Text style={styles.walletNote}>
            Wallet balance: {formatNaira(walletBalance)} ·{" "}
            <Text style={styles.link} onPress={() => navigation.navigate("Wallet")}>Top up</Text>
          </Text>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.dark.bg0 },
  title: { fontSize: 19, fontWeight: "700", color: colors.dark.text, marginBottom: spacing.md },
  rowBetween: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  planName: { color: colors.dark.text, fontSize: 15, fontWeight: "700" },
  cardLabel: { color: colors.dark.text, fontWeight: "600", fontSize: 13, marginBottom: 4 },
  price: { color: colors.amber, fontSize: 16, fontWeight: "700", marginBottom: 6 },
  meta: { color: colors.dark.textMuted, fontSize: 12, marginTop: 2, lineHeight: 17 },
  warningText: { color: "#FF9B8A", fontSize: 11, marginTop: 6 },
  errorText: { color: "#FF9B8A", fontSize: 12, marginBottom: spacing.md, textAlign: "center" },
  successText: { color: "#8FD9C4", fontSize: 12, marginTop: 8, textAlign: "center" },
  input: {
    backgroundColor: colors.dark.fieldBg,
    color: colors.dark.text,
    borderRadius: 10,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    fontSize: 13,
  },
  walletNote: { color: colors.dark.textMuted, fontSize: 12, textAlign: "center", marginTop: spacing.sm },
  link: { color: colors.tealBright, fontWeight: "600" },
});
