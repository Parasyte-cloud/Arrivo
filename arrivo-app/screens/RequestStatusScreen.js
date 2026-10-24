import React, { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { Card, Button, Tag } from "../components/UI";
import { GradientBackground } from "../components/GradientBackground";
import ParasyteSignature from "../components/ParasyteSignature";
import { REQUEST_TIERS, canCancel, formatNaira, isOpen, optionLabel, statusInfo } from "../tiers/requestTiers";
import { colors, spacing } from "../theme/tokens";
import { useAuth } from "../context/AuthContext";
import { cancelServiceRequest, getServiceRequest } from "../services/api";
import { formatLagos } from "../utils/lagosTime";
import { messageWithCode } from "../utils/errorRef";

const POLL_MS = 10000;
const STEP_LABELS = ["Sent", "Confirmed", "Under way", "Done"];

// Where a request stands. Refreshes itself while the request is still moving,
// and can be cancelled until the trip starts.
export default function RequestStatusScreen({ route, navigation }) {
  const { requestId, justSent } = route.params || {};
  const { token } = useAuth();
  const [request, setRequest] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [cancelling, setCancelling] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const load = useCallback(async () => {
    try {
      const data = await getServiceRequest(token, requestId);
      if (!mounted.current) return;
      setRequest(data.request);
      setError(null);
    } catch (e) {
      if (!mounted.current) return;
      setError(messageWithCode(e, "We could not load this request."));
    } finally {
      if (mounted.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [token, requestId]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  // Keep an open request fresh without the rider pulling to refresh.
  const open = request ? isOpen(request.status) : false;
  useEffect(() => {
    if (!open) return undefined;
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [open, load]);

  const cancel = () => {
    Alert.alert("Cancel this request?", "Our team will be told straight away.", [
      { text: "Keep it", style: "cancel" },
      {
        text: "Cancel request",
        style: "destructive",
        onPress: async () => {
          setCancelling(true);
          try {
            const data = await cancelServiceRequest(token, requestId);
            if (mounted.current) setRequest(data.request);
          } catch (e) {
            if (mounted.current) setError(messageWithCode(e, "We could not cancel this request."));
            load();
          } finally {
            if (mounted.current) setCancelling(false);
          }
        },
      },
    ]);
  };

  if (loading && !request) {
    return (
      <View style={[styles.screen, styles.center]}>
        <GradientBackground variant="dark" />
        <ActivityIndicator color={colors.amber} size="large" />
      </View>
    );
  }

  if (!request) {
    return (
      <View style={styles.screen}>
        <GradientBackground variant="dark" />
        <View style={styles.content}>
          <Text style={styles.error}>{error || "This request could not be found."}</Text>
          <Button label="Try again" onPress={() => { setLoading(true); load(); }} />
        </View>
      </View>
    );
  }

  const cfg = REQUEST_TIERS[request.tier];
  const info = statusInfo(request.status);
  const cancelled = request.status === "cancelled";
  const priced = request.quotedFareNaira != null && !cancelled;

  return (
    <View style={styles.screen}>
      <GradientBackground variant="dark" />
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={colors.amber} />}
      >
        {justSent && request.status === "pending" ? (
          <Card tone="dark" tinted style={{ marginBottom: spacing.md }}>
            <Text style={styles.sentTitle}>Request sent</Text>
            <Text style={styles.body}>We will call you shortly to confirm the details and the price.</Text>
          </Card>
        ) : null}

        <Card tone="dark" style={{ marginBottom: spacing.md }}>
          <View style={styles.rowBetween}>
            <Text style={styles.tier}>{cfg ? cfg.label : "Request"}</Text>
            <Tag label={info.label.toUpperCase()} tone={cancelled ? "teal" : "amber"} />
          </View>
          <Text style={[styles.body, { marginTop: spacing.sm }]}>{info.detail}</Text>

          {!cancelled ? (
            <View style={styles.progress} accessibilityLabel={`Step ${info.step} of 4: ${info.label}`}>
              {STEP_LABELS.map((label, i) => {
                const done = info.step >= i + 1;
                return (
                  <View key={label} style={styles.progressItem}>
                    <View style={[styles.dot, done && styles.dotDone]} />
                    <Text style={[styles.stepLabel, done && styles.stepLabelDone]}>{label}</Text>
                  </View>
                );
              })}
            </View>
          ) : null}
        </Card>

        <Card tone="dark" style={{ marginBottom: spacing.md }}>
          <Row label={cfg ? cfg.pickupLabel : "From"} value={request.pickupAddress} />
          <Row label={cfg ? cfg.destinationLabel : "To"} value={request.destinationAddress} />
          <Row label={cfg ? cfg.whenLabel : "When"} value={formatLagos(request.requestedAt)} />
          <Row label={cfg ? cfg.optionLabel : "Type"} value={optionLabel(request.tier, request.option)} />
          {request.crewSize ? <Row label="Crew" value={`${request.crewSize} movers`} /> : null}
          {request.passengerCount > 1 ? <Row label="Passengers" value={String(request.passengerCount)} /> : null}
          {request.details ? <Row label="Notes" value={request.details} /> : null}
          {priced ? <Row label="Price" value={formatNaira(request.quotedFareNaira)} strong /> : null}
        </Card>

        {error ? <Text style={styles.error}>{error}</Text> : null}

        {canCancel(request.status) ? (
          cancelling ? <ActivityIndicator color={colors.amber} /> : <Button label="Cancel request" variant="ghost" tone="dark" onPress={cancel} />
        ) : null}
        <View style={{ height: spacing.sm }} />
        <Button label="Back to Home" variant="ghost" tone="dark" onPress={() => navigation.popToTop()} />

        <ParasyteSignature />
      </ScrollView>
    </View>
  );
}

function Row({ label, value, strong }) {
  if (!value) return null;
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[styles.rowValue, strong && styles.rowStrong]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.dark.bg0 },
  center: { alignItems: "center", justifyContent: "center" },
  content: { padding: spacing.lg, paddingBottom: 40 },
  rowBetween: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  tier: { color: colors.dark.text, fontSize: 18, fontWeight: "800" },
  sentTitle: { color: colors.dark.text, fontSize: 15, fontWeight: "800", marginBottom: 4 },
  body: { color: colors.dark.textMuted, fontSize: 13, lineHeight: 19 },
  progress: { flexDirection: "row", justifyContent: "space-between", marginTop: spacing.md },
  progressItem: { alignItems: "center", flex: 1 },
  dot: { width: 12, height: 12, borderRadius: 6, backgroundColor: "rgba(255,255,255,0.18)" },
  dotDone: { backgroundColor: colors.amber },
  stepLabel: { color: colors.dark.textMuted, fontSize: 10.5, marginTop: 6, fontWeight: "600" },
  stepLabelDone: { color: colors.dark.text },
  row: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 8, gap: spacing.md },
  rowLabel: { color: colors.dark.textMuted, fontSize: 12.5, width: 96 },
  rowValue: { color: colors.dark.text, fontSize: 13.5, fontWeight: "600", flex: 1, textAlign: "right" },
  rowStrong: { color: colors.amber, fontSize: 16, fontWeight: "800" },
  error: { color: "#FF9B8A", fontSize: 12.5, marginBottom: spacing.md, textAlign: "center", lineHeight: 18 },
});
