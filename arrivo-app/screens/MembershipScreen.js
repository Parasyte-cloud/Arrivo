import React, { useCallback, useRef, useState } from "react";
import { View, Text, StyleSheet, ScrollView, ActivityIndicator, TextInput, KeyboardAvoidingView, Platform } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { Card, Button, Tag } from "../components/UI";
import { GradientBackground } from "../components/GradientBackground";
import { colors, spacing } from "../theme/tokens";
import { useAuth } from "../context/AuthContext";
import {
  getMembership, getWallet, getMembershipPlans,
  subscribeMembership, addMembershipProfileUser,
} from "../services/api";
import { useTranslation } from "react-i18next";
import ParasyteSignature from "../components/ParasyteSignature";

function formatNaira(amount) {
  return "₦" + Number(amount || 0).toLocaleString();
}

function formatDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

const PLAN_LABEL = { premium: "Premium", executive: "Executive", executive_profile: "Executive (profile user)" };

export default function MembershipScreen({ navigation }) {
  const { t } = useTranslation();
  const { token } = useAuth();
  const [membership, setMembership] = useState(null);
  const [profileUsers, setProfileUsers] = useState([]);
  const [plans, setPlans] = useState([]);
  const [walletBalance, setWalletBalance] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busyPlan, setBusyPlan] = useState(null);
  const [error, setError] = useState(null);
  const [profileUserEmail, setProfileUserEmail] = useState("");
  const [linkStatus, setLinkStatus] = useState(null);
  // Synchronous double-tap guard for subscribe, mirroring ScanScreen.js's
  // scannedRef — the `busyPlan` state guard alone can't stop a second tap
  // landing in the same tick/frame, before React re-renders with a
  // spinner in place of the button.
  const submittingRef = useRef(false);

  const load = useCallback(async () => {
    try {
      const [m, w, p] = await Promise.all([getMembership(token), getWallet(token), getMembershipPlans()]);
      setMembership(m.membership);
      setProfileUsers(m.profileUsers || []);
      setWalletBalance(w.balanceNaira);
      setPlans(p.plans || []);
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

  const subscribe = async (planKey) => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setBusyPlan(planKey);
    setError(null);
    try {
      await subscribeMembership(token, planKey);
      await load();
    } catch (e) {
      setError(e.message || "Couldn't subscribe. Please try again.");
    } finally {
      setBusyPlan(null);
      submittingRef.current = false;
    }
  };

  const addProfileUser = async () => {
    if (!profileUserEmail.trim()) return;
    setLinkStatus("busy");
    setError(null);
    try {
      await addMembershipProfileUser(token, profileUserEmail.trim().toLowerCase());
      setProfileUserEmail("");
      setLinkStatus("success");
      await load();
    } catch (e) {
      setLinkStatus(null);
      setError(e.message || "Couldn't add that profile user.");
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

  const isExecutiveOwner = membership?.plan_type === "executive";
  const maxAdditionalProfileUsers = isExecutiveOwner ? (membership.max_profile_users || 1) - 1 : 0;

  return (
    <View style={styles.screen}>
      <GradientBackground variant="dark" />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 0}
      >
      <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>{t("membership.membership")}</Text>

        {error ? <Text style={styles.errorText}>{error}</Text> : null}

        {membership ? (
          <Card tone="dark" tinted style={{ marginBottom: spacing.md }}>
            <View style={styles.rowBetween}>
              <Text style={styles.planName}>{PLAN_LABEL[membership.plan_type] || membership.plan_type}</Text>
              <Tag label={t("membership.active")} tone="teal" />
            </View>
            <Text style={styles.meta}>
              {membership.cashback_percent > 0
                ? t("membership.cashbackCredited", { percent: membership.cashback_percent })
                : t("membership.noPerTripCharge")}
            </Text>
            <Text style={styles.meta}>Renews / expires {formatDate(membership.expires_at)}</Text>
          </Card>
        ) : (
          <Card tone="dark" style={{ marginBottom: spacing.md }}>
            <Text style={styles.meta}>{t("membership.noActiveMembershipYet")}</Text>
          </Card>
        )}

        {!membership
          ? plans.map((plan) => (
              <Card tone="dark" style={{ marginBottom: spacing.md }} key={plan.key}>
                <Text style={styles.cardLabel}>{plan.label}</Text>
                <Text style={styles.price}>{formatNaira(plan.priceNaira)}/month</Text>
                <Text style={styles.meta}>{plan.tripCoverage}</Text>
                <Text style={styles.meta}>{t("membership.cashbackOnEveryTripCredited", { cashbackPercent: plan.cashbackPercent })}</Text>
                <Text style={styles.meta}>
                  {plan.maxProfileUsers > 1 ? t("membership.upToUsers", { count: plan.maxProfileUsers }) : t("membership.singleUser")}
                </Text>
                {walletBalance != null && walletBalance < plan.priceNaira ? (
                  <Text style={styles.warningText}>
                    Wallet balance is {formatNaira(walletBalance)}: top up at least {formatNaira(plan.priceNaira - walletBalance)} more to subscribe.
                  </Text>
                ) : null}
                <View style={{ height: spacing.sm }} />
                {busyPlan === plan.key ? (
                  <ActivityIndicator color={colors.amber} />
                ) : (
                  <Button
                    label={`Subscribe to ${plan.label}`}
                    variant="ghost"
                    tone="dark"
                    onPress={() => subscribe(plan.key)}
                    disabled={busyPlan != null || walletBalance == null || walletBalance < plan.priceNaira}
                  />
                )}
              </Card>
            ))
          : null}

        {isExecutiveOwner ? (
          <Card tone="dark" style={{ marginBottom: spacing.md }}>
            <Text style={styles.cardLabel}>
              {t("membership.profileUsers", { length: profileUsers.length, maxAdditionalProfileUsers })}
            </Text>
            <Text style={styles.meta}>{t("membership.addAProfileUserBy")}</Text>
            <View style={{ height: spacing.sm }} />
            {profileUsers.map((u) => (
              <Text style={styles.meta} key={u.id}>• {u.name} ({u.email})</Text>
            ))}
            {profileUsers.length < maxAdditionalProfileUsers ? (
              <>
                <View style={{ height: spacing.sm }} />
                <TextInput
                  style={styles.input}
                  placeholder={t("membership.teammateExampleCom")}
                  placeholderTextColor={colors.dark.textMuted}
                  value={profileUserEmail}
                  onChangeText={setProfileUserEmail}
                  autoCapitalize="none"
                  keyboardType="email-address"
                />
                <View style={{ height: spacing.sm }} />
                {linkStatus === "busy" ? (
                  <ActivityIndicator color={colors.amber} />
                ) : (
                  <Button label={t("membership.addProfileUser")} variant="ghost" tone="dark" onPress={addProfileUser} />
                )}
                {linkStatus === "success" ? <Text style={styles.successText}>{t("membership.profileUserAdded")}</Text> : null}
              </>
            ) : null}
          </Card>
        ) : null}

        {walletBalance != null ? (
          <Text style={styles.walletNote}>
            {t("membership.walletBalance")}: {formatNaira(walletBalance)} ·{" "}
            <Text style={styles.link} onPress={() => navigation.navigate("Wallet")}>{t("membership.topUp")}</Text>
          </Text>
        ) : null}
        <ParasyteSignature />
      </ScrollView>
      </KeyboardAvoidingView>
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
  warningText: { color: "#C2362B", fontSize: 11, marginTop: 6 },
  errorText: { color: "#C2362B", fontSize: 12, marginBottom: spacing.md, textAlign: "center" },
  successText: { color: colors.success, fontSize: 12, marginTop: 8, textAlign: "center" },
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
