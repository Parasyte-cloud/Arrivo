// Arrivo Family Plan — "One account. Your whole family. One less thing to
// worry about." A family admin creates a plan, funds a shared wallet, and
// invites up to the tier's member cap; any active member can then book a
// ride against that wallet from CheckoutScreen (paymentMethod:
// 'family_wallet'), so nobody is stranded waiting for the admin to be
// reachable. Follows the same load/top-up/AppState patterns already
// established by MembershipScreen.js and WalletScreen.js.
import React, { useCallback, useEffect, useRef, useState } from "react";
import { View, Text, StyleSheet, ScrollView, ActivityIndicator, TextInput, Pressable, Linking, AppState, KeyboardAvoidingView, Platform } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { Card, Button, Tag } from "../components/UI";
import { GradientBackground } from "../components/GradientBackground";
import { colors, spacing } from "../theme/tokens";
import { useAuth } from "../context/AuthContext";
import {
  getFamilyPlanPricing, getMyFamilyPlan, createFamilyPlan, addFamilyMember,
  removeFamilyMember, verifyFamilyWalletTopup, initializePayment,
} from "../services/api";

function formatNaira(amount) {
  return "₦" + Number(amount || 0).toLocaleString();
}

const PLAN_TITLES = { lite: "Family Lite", plus: "Family Plus", max: "Family Max" };

export default function FamilyPlanScreen({ navigation }) {
  const { user, token } = useAuth();
  const [loading, setLoading] = useState(true);
  const [pricing, setPricing] = useState([]);
  const [plan, setPlan] = useState(null);
  const [members, setMembers] = useState([]);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const submittingRef = useRef(false);

  const [addValue, setAddValue] = useState("");
  const [addStatus, setAddStatus] = useState(null); // null | 'busy' | 'success'

  const [showTopUp, setShowTopUp] = useState(false);
  const [amountInput, setAmountInput] = useState("");
  const [topUpStatus, setTopUpStatus] = useState("idle"); // idle | opening | verifying | error
  const [topUpError, setTopUpError] = useState(null);
  const pendingTopUpRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const [pricingData, mineData] = await Promise.all([getFamilyPlanPricing(token), getMyFamilyPlan(token)]);
      setPricing(pricingData.tiers || []);
      setPlan(mineData.plan);
      setMembers(mineData.members || []);
      setError(null);
    } catch (e) {
      setError(e.message || "Couldn't load your family plan.");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      if (nextState === "active" && pendingTopUpRef.current) {
        const reference = pendingTopUpRef.current;
        pendingTopUpRef.current = null;
        verifyTopUp(reference);
      }
    });
    return () => subscription.remove();
  }, [plan]);

  const verifyTopUp = async (reference) => {
    setTopUpStatus("verifying");
    try {
      const result = await verifyFamilyWalletTopup(token, plan.id, reference);
      if (result.success) {
        setAmountInput("");
        setShowTopUp(false);
        setTopUpStatus("idle");
        await load();
      } else {
        setTopUpStatus("error");
        setTopUpError("Couldn't confirm the top-up. If you were charged, contact support with reference " + reference + ".");
      }
    } catch (e) {
      setTopUpStatus("error");
      setTopUpError(e.message || "Something went wrong confirming your top-up.");
    }
  };

  const topUp = async () => {
    const amount = Number(amountInput);
    setTopUpError(null);
    if (!amount || amount < 100) {
      setTopUpError("Enter an amount of at least ₦100.");
      return;
    }
    setTopUpStatus("opening");
    try {
      const { authorizationUrl, reference } = await initializePayment(user.email, amount);
      pendingTopUpRef.current = reference;
      await Linking.openURL(authorizationUrl);
    } catch (e) {
      setTopUpStatus("error");
      setTopUpError(e.message || "Something went wrong starting the top-up.");
    }
  };

  const choosePlan = async (planType) => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await createFamilyPlan(token, planType);
      await load();
    } catch (e) {
      setError(e.message || "Couldn't create the family plan.");
    } finally {
      setBusy(false);
      submittingRef.current = false;
    }
  };

  const addMember = async () => {
    if (!addValue.trim()) return;
    setAddStatus("busy");
    setError(null);
    try {
      const isEmail = addValue.includes("@");
      await addFamilyMember(token, plan.id, isEmail ? { email: addValue.trim().toLowerCase() } : { phone: addValue.trim() });
      setAddValue("");
      setAddStatus("success");
      await load();
    } catch (e) {
      setAddStatus(null);
      setError(e.message || "Couldn't add that member.");
    }
  };

  const removeMember = async (memberId) => {
    setError(null);
    try {
      await removeFamilyMember(token, plan.id, memberId);
      await load();
    } catch (e) {
      setError(e.message || "Couldn't remove that member.");
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

  const isAdmin = plan?.myRole === "admin";

  return (
    <View style={styles.screen}>
      <GradientBackground variant="dark" />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 0}>
        <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
          <Text style={styles.title}>Family Plan</Text>
          <Text style={styles.subtitle}>One account. Your whole family. One less thing to worry about.</Text>

          {error ? <Text style={styles.errorText}>{error}</Text> : null}

          {!plan ? (
            <>
              {pricing.map((tier) => (
                <Card key={tier.planType} tone="dark" style={{ marginBottom: spacing.md }}>
                  <View style={styles.rowBetween}>
                    <Text style={styles.planName}>{PLAN_TITLES[tier.planType]}</Text>
                    <Text style={styles.price}>{formatNaira(tier.priceNaira)}/mo</Text>
                  </View>
                  <Text style={styles.meta}>Up to {tier.maxMembers} members, including you.</Text>
                  <View style={{ height: spacing.sm }} />
                  {busy ? (
                    <ActivityIndicator color={colors.amber} />
                  ) : (
                    <Button label={`Choose ${PLAN_TITLES[tier.planType]}`} variant="ghost" tone="dark" onPress={() => choosePlan(tier.planType)} />
                  )}
                </Card>
              ))}
            </>
          ) : (
            <>
              <Card tone="dark" tinted style={{ marginBottom: spacing.md }}>
                <View style={styles.rowBetween}>
                  <Text style={styles.planName}>{PLAN_TITLES[plan.planType]}</Text>
                  <Tag label={isAdmin ? "Administrator" : "Member"} tone="teal" />
                </View>
                <Text style={styles.meta}>{members.length} / {plan.maxMembers} members</Text>
              </Card>

              <Card tone="dark" style={{ marginBottom: spacing.md }}>
                <Text style={styles.cardLabel}>Family Wallet</Text>
                <Text style={styles.balance}>{formatNaira(plan.walletBalanceNaira)}</Text>
                {plan.walletBalanceNaira <= 0 ? (
                  <Text style={styles.warningText}>Your Family Wallet is empty. Top up to continue riding.</Text>
                ) : null}
                {isAdmin ? (
                  !showTopUp ? (
                    <Button label="Top Up Family Wallet" variant="ghost" tone="dark" onPress={() => setShowTopUp(true)} style={{ marginTop: spacing.sm }} trailingIcon />
                  ) : (
                    <View style={{ marginTop: spacing.sm }}>
                      <TextInput
                        style={styles.input}
                        placeholder="Amount (₦)"
                        placeholderTextColor={colors.dark.textMuted}
                        keyboardType="number-pad"
                        value={amountInput}
                        onChangeText={setAmountInput}
                        editable={topUpStatus === "idle" || topUpStatus === "error"}
                      />
                      {topUpError ? <Text style={styles.errorText}>{topUpError}</Text> : null}
                      <View style={{ height: spacing.sm }} />
                      {topUpStatus === "opening" || topUpStatus === "verifying" ? (
                        <ActivityIndicator color={colors.amber} />
                      ) : (
                        <Button label="Continue to payment" onPress={topUp} trailingIcon />
                      )}
                    </View>
                  )
                ) : (
                  <Text style={styles.meta}>Only your family administrator can top up this wallet.</Text>
                )}
              </Card>

              <Card tone="dark" style={{ marginBottom: spacing.md }}>
                <Text style={styles.cardLabel}>Members</Text>
                {members.map((m) => (
                  <View key={m.id} style={styles.memberRow}>
                    <View>
                      <Text style={styles.memberName}>{m.name}{m.member_role === "admin" ? " (You)" : ""}</Text>
                      <Text style={styles.meta}>{m.phone || m.email}</Text>
                    </View>
                    {isAdmin && m.member_role !== "admin" ? (
                      <Pressable onPress={() => removeMember(m.id)}>
                        <Text style={styles.removeLink}>Remove</Text>
                      </Pressable>
                    ) : null}
                  </View>
                ))}

                {isAdmin && members.length < plan.maxMembers ? (
                  <View style={{ marginTop: spacing.sm }}>
                    <Text style={styles.meta}>Add a member by the phone or email they used to sign up.</Text>
                    <View style={{ height: 8 }} />
                    <TextInput
                      style={styles.input}
                      placeholder="Phone or email"
                      placeholderTextColor={colors.dark.textMuted}
                      value={addValue}
                      onChangeText={setAddValue}
                      autoCapitalize="none"
                    />
                    <View style={{ height: spacing.sm }} />
                    {addStatus === "busy" ? (
                      <ActivityIndicator color={colors.amber} />
                    ) : (
                      <Button label="Add member" variant="ghost" tone="dark" onPress={addMember} />
                    )}
                    {addStatus === "success" ? <Text style={styles.successText}>Member added ✓</Text> : null}
                  </View>
                ) : null}
              </Card>

              <Text style={styles.walletNote}>
                Book a ride and choose "Family Wallet" at checkout — any member can do this for themselves,{isAdmin ? " or you can book on their behalf from the ride booking screen." : "."}
              </Text>
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.dark.bg0 },
  title: { fontSize: 19, fontWeight: "700", color: colors.dark.text, marginBottom: 4 },
  subtitle: { fontSize: 12, color: colors.dark.textMuted, marginBottom: spacing.md, fontStyle: "italic" },
  rowBetween: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  planName: { color: colors.dark.text, fontSize: 15, fontWeight: "700" },
  cardLabel: { color: colors.dark.text, fontWeight: "600", fontSize: 13, marginBottom: 4 },
  price: { color: colors.amber, fontSize: 16, fontWeight: "700" },
  balance: { color: colors.amber, fontSize: 22, fontWeight: "700", marginTop: 4 },
  meta: { color: colors.dark.textMuted, fontSize: 12, marginTop: 2, lineHeight: 17 },
  warningText: { color: "#FF9B8A", fontSize: 11, marginTop: 6 },
  errorText: { color: "#FF9B8A", fontSize: 12, marginBottom: spacing.md, textAlign: "center" },
  successText: { color: "#8FD9C4", fontSize: 12, marginTop: 8, textAlign: "center" },
  memberRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 8, borderTopWidth: 1, borderTopColor: colors.dark.divider || "rgba(255,255,255,0.08)" },
  memberName: { color: colors.dark.text, fontSize: 13, fontWeight: "600" },
  removeLink: { color: "#FF9B8A", fontSize: 12, fontWeight: "600" },
  input: {
    backgroundColor: colors.dark.fieldBg,
    color: colors.dark.text,
    borderRadius: 10,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    fontSize: 13,
  },
  walletNote: { color: colors.dark.textMuted, fontSize: 12, textAlign: "center", marginTop: spacing.sm, lineHeight: 17 },
});
