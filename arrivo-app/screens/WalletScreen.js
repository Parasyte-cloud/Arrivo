import React, { useCallback, useEffect, useState } from "react";
import { View, Text, StyleSheet, ScrollView, ActivityIndicator, TextInput, RefreshControl } from "react-native";
import * as WebBrowser from "expo-web-browser";
import { Card, Button } from "../components/UI";
import { colors, spacing, radius } from "../theme/tokens";
import { getWallet, initializePayment, verifyWalletTopup } from "../services/api";
import { useAuth } from "../context/AuthContext";

function formatNaira(amount) {
  return "₦" + Number(amount || 0).toLocaleString();
}

function formatDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString() + " · " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function transactionLabel(tx) {
  if (tx.type === "topup") return "Wallet top-up";
  if (tx.type === "ride_charge") return "Ride payment";
  if (tx.type === "membership_charge") return "Membership";
  return tx.description || tx.type;
}

export default function WalletScreen() {
  const { user, token } = useAuth();
  const [balance, setBalance] = useState(null);
  const [transactions, setTransactions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState(null);

  const [showTopUp, setShowTopUp] = useState(false);
  const [amountInput, setAmountInput] = useState("");
  const [topUpStatus, setTopUpStatus] = useState("idle"); // idle | opening | verifying | error
  const [topUpError, setTopUpError] = useState(null);

  const load = useCallback(async () => {
    try {
      const data = await getWallet(token);
      setBalance(data.balanceNaira);
      setTransactions(data.transactions || []);
      setLoadError(null);
    } catch (e) {
      setLoadError(e.message || "Couldn't load your wallet. Pull down to try again.");
    }
  }, [token]);

  useEffect(() => {
    (async () => {
      setLoading(true);
      await load();
      setLoading(false);
    })();
  }, [load]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
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
      const result = await WebBrowser.openAuthSessionAsync(authorizationUrl, undefined);

      if (result.type !== "success" && result.type !== "dismiss") {
        setTopUpStatus("idle");
        return;
      }

      setTopUpStatus("verifying");
      const verification = await verifyWalletTopup(token, reference);

      if (verification.success) {
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
      setTopUpError(e.message || "Something went wrong starting the top-up.");
    }
  };

  if (loading) {
    return (
      <View style={[styles.screen, styles.centered]}>
        <ActivityIndicator color={colors.amber} />
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <ScrollView
        contentContainerStyle={{ padding: spacing.lg, paddingBottom: 40 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.amber} />}
      >
        <Text style={styles.title}>Wallet</Text>

        {loadError ? <Text style={styles.errorText}>{loadError}</Text> : null}

        <Card tinted style={{ marginBottom: spacing.md }}>
          <Text style={styles.balanceLabel}>Balance</Text>
          <Text style={styles.balance}>{formatNaira(balance)}</Text>
        </Card>

        {!showTopUp ? (
          <Button label="Top Up Wallet" onPress={() => setShowTopUp(true)} />
        ) : (
          <Card style={{ marginBottom: spacing.md }}>
            <TextInput
              style={styles.input}
              placeholder="Amount (₦)"
              placeholderTextColor={colors.textMuted}
              keyboardType="number-pad"
              value={amountInput}
              onChangeText={setAmountInput}
              editable={topUpStatus === "idle" || topUpStatus === "error"}
            />
            {topUpError ? <Text style={styles.errorText}>{topUpError}</Text> : null}
            {topUpStatus === "opening" || topUpStatus === "verifying" ? (
              <View style={{ alignItems: "center", paddingVertical: spacing.sm }}>
                <ActivityIndicator color={colors.amber} />
                <Text style={styles.statusText}>
                  {topUpStatus === "opening" ? "Opening secure checkout…" : "Confirming your top-up…"}
                </Text>
              </View>
            ) : (
              <Button label="Continue to payment" onPress={topUp} />
            )}
          </Card>
        )}

        <Text style={[styles.cardLabel, { marginTop: spacing.lg }]}>Recent activity</Text>
        {transactions.length === 0 ? (
          <Text style={styles.emptyText}>No transactions yet.</Text>
        ) : (
          transactions.map((tx) => {
            const amount = Number(tx.amount_naira);
            const isCredit = amount > 0;
            return (
              <Card key={tx.id} style={{ marginBottom: spacing.sm }}>
                <View style={styles.row}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.txLabel}>{transactionLabel(tx)}</Text>
                    <Text style={styles.txDate}>{formatDate(tx.created_at)}</Text>
                  </View>
                  <Text style={[styles.txAmount, { color: isCredit ? colors.tealBright : colors.coral }]}>
                    {isCredit ? "+" : ""}{formatNaira(amount)}
                  </Text>
                </View>
              </Card>
            );
          })
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  centered: { alignItems: "center", justifyContent: "center" },
  title: { fontSize: 19, fontWeight: "700", color: colors.ink, marginBottom: spacing.md },
  balanceLabel: { color: colors.textMuted, fontSize: 12 },
  balance: { color: colors.amber, fontSize: 28, fontWeight: "700", marginTop: 4 },
  cardLabel: { color: colors.ink, fontWeight: "600", fontSize: 12, marginBottom: 8 },
  emptyText: { color: colors.textMuted, fontSize: 13 },
  input: {
    backgroundColor: colors.fieldBg,
    borderRadius: radius.sm + 2,
    paddingVertical: 12,
    paddingHorizontal: spacing.md,
    color: colors.ink,
    fontSize: 15,
    marginBottom: spacing.sm,
  },
  statusText: { color: colors.ink, fontSize: 12.5, marginTop: 8, textAlign: "center" },
  errorText: { color: colors.coral, fontSize: 12, marginBottom: spacing.sm, textAlign: "center" },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  txLabel: { color: colors.ink, fontSize: 13.5, fontWeight: "600" },
  txDate: { color: colors.textMuted, fontSize: 11, marginTop: 2 },
  txAmount: { fontSize: 14, fontWeight: "700" },
});
