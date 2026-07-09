import React from "react";
import { View, Text, StyleSheet, ScrollView } from "react-native";
import { Card, Button } from "../components/UI";
import { colors, spacing } from "../theme/tokens";

export default function WalletScreen() {
  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingBottom: 40 }}>
        <Text style={styles.title}>Wallet</Text>
        <Card tinted style={{ marginBottom: spacing.md }}>
          <Text style={styles.balanceLabel}>Balance</Text>
          <Text style={styles.balance}>₦8,200</Text>
        </Card>
        <Card style={{ marginBottom: spacing.md }}>
          <Text style={styles.cardLabel}>Payment methods</Text>
          <Text style={styles.method}>💳 Paystack — •••• 4821</Text>
        </Card>
        <Button label="Top Up Wallet" onPress={() => {}} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.ink },
  title: { fontSize: 19, fontWeight: "700", color: colors.cream, marginBottom: spacing.md },
  balanceLabel: { color: colors.textMuted, fontSize: 12 },
  balance: { color: colors.amber, fontSize: 28, fontWeight: "700", marginTop: 4 },
  cardLabel: { color: colors.cream, fontWeight: "600", fontSize: 12, marginBottom: 8 },
  method: { color: colors.cream, fontSize: 13 },
});
