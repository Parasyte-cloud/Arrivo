import React, { useCallback, useEffect, useState } from "react";
import { View, Text, StyleSheet, ActivityIndicator } from "react-native";
import { Card } from "./UI";
import { colors, spacing } from "../theme/tokens";
import { useAuth } from "../context/AuthContext";
import { getRideReceipt } from "../services/api";

const SERVICE = { ride: "RideArrivo", express: "ArrivoExpress", chauffeur: "ArrivoChauffeur" };
const naira = (n) => `₦${Number(n || 0).toLocaleString()}`;

// The receipt for a finished trip. Same card for every service. Shows nothing
// until the trip is completed, and never gets in the way of the screen.
export default function ReceiptCard({ rideId, rideStatus }) {
  const { token } = useAuth();
  const [receipt, setReceipt] = useState(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async () => {
    try { setReceipt((await getRideReceipt(token, rideId)).receipt); setFailed(false); } catch (e) { setFailed(true); }
  }, [token, rideId]);
  useEffect(() => { if (rideStatus === "completed") load(); }, [rideStatus, load]);

  if (rideStatus !== "completed") return null;
  if (!receipt) return failed ? null : <ActivityIndicator color={colors.amber} style={{ marginTop: spacing.md }} />;
  const when = receipt.completedAt ? new Date(receipt.completedAt).toLocaleString() : "";
  return (
    <Card tone="dark" style={{ marginTop: spacing.md }}>
      <Text style={styles.title}>Receipt</Text>
      <Text style={styles.meta}>{SERVICE[receipt.service] || "RideArrivo"} · Trip #{receipt.tripNumber}{when ? ` · ${when}` : ""}</Text>
      <Text style={styles.route}>{[receipt.pickup, ...receipt.stops].join("  →  ")}</Text>
      {receipt.driver ? <Text style={styles.meta}>Driver {receipt.driver.name}{receipt.driver.plate ? ` · ${receipt.driver.vehicle ? receipt.driver.vehicle + " " : ""}${receipt.driver.plate}` : ""}</Text> : null}
      <View style={styles.rule} />
      {receipt.lines.map((l) => (
        <View key={l.label} style={styles.row}><Text style={styles.label}>{l.label}</Text><Text style={styles.value}>{naira(l.naira)}</Text></View>
      ))}
      {receipt.promo ? <Text style={styles.promo}>Promo{receipt.promo.code ? ` ${receipt.promo.code}` : ""} saved you {naira(receipt.promo.savedNaira)}</Text> : null}
      <View style={styles.rule} />
      <View style={styles.row}><Text style={styles.total}>Total</Text><Text style={styles.total}>{naira(receipt.totalNaira)}</Text></View>
      {receipt.paymentMethod ? <Text style={styles.meta}>Paid by {String(receipt.paymentMethod).replace(/_/g, " ")}</Text> : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 16, fontWeight: "800", color: colors.dark.text },
  meta: { fontSize: 12.5, color: colors.dark.textMuted, marginTop: 4 },
  route: { fontSize: 13.5, color: colors.dark.text, marginTop: spacing.sm },
  rule: { height: 1, backgroundColor: colors.dark.hairline, marginVertical: spacing.sm },
  row: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 3 },
  label: { fontSize: 14, color: colors.dark.text },
  value: { fontSize: 14, color: colors.dark.text, fontWeight: "600" },
  promo: { fontSize: 12.5, color: colors.dark.textMuted, marginTop: 4 },
  total: { fontSize: 16, fontWeight: "800", color: colors.dark.text },
});
