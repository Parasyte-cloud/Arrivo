import React, { useEffect, useState } from "react";
import { View, Text, StyleSheet, ActivityIndicator } from "react-native";
import { colors, spacing } from "../theme/tokens";
import { useAuth } from "../context/AuthContext";
import { getRideReceipt } from "../services/api";

const naira = (n) => `₦${Number(n || 0).toLocaleString()}`;

// The receipt for one finished trip, as the driver sees it: the rider's name
// (only now that the trip is done) and the fare lines. Loads when opened.
export default function DriverReceipt({ rideId }) {
  const { token } = useAuth();
  const [receipt, setReceipt] = useState(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    getRideReceipt(token, rideId).then((r) => live && setReceipt(r.receipt)).catch(() => live && setFailed(true));
    return () => { live = false; };
  }, [token, rideId]);

  if (failed) return <Text style={styles.meta}>The receipt could not be loaded. Pull down to refresh and try again.</Text>;
  if (!receipt) return <ActivityIndicator color={colors.amber} style={{ marginTop: spacing.sm }} />;
  return (
    <View style={{ marginTop: spacing.sm }}>
      <View style={styles.rule} />
      {receipt.rider ? <Text style={styles.meta}>Rider {receipt.rider.name}</Text> : null}
      {receipt.lines.map((l) => (
        <View key={l.label} style={styles.row}><Text style={styles.label}>{l.label}</Text><Text style={styles.value}>{naira(l.naira)}</Text></View>
      ))}
      <View style={styles.rule} />
      <View style={styles.row}><Text style={styles.total}>Total</Text><Text style={styles.total}>{naira(receipt.totalNaira)}</Text></View>
      {receipt.paymentMethod ? <Text style={styles.meta}>Paid by {String(receipt.paymentMethod).replace(/_/g, " ")}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  rule: { height: 1, backgroundColor: colors.dark.hairline, marginVertical: spacing.sm },
  row: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 2 },
  label: { fontSize: 13, color: colors.dark.text },
  value: { fontSize: 13, color: colors.dark.text, fontWeight: "600" },
  total: { fontSize: 14, fontWeight: "800", color: colors.dark.text },
  meta: { fontSize: 12, color: colors.dark.textMuted, marginTop: 3 },
});
