import React, { useEffect, useState } from "react";
import { View, Text, StyleSheet, ScrollView, Alert, Share, Pressable, ActivityIndicator } from "react-native";
import { Card, Button, Tag } from "../components/UI";
import { MapPlaceholder } from "../components/MapPlaceholder";
import { colors, spacing, radius } from "../theme/tokens";
import { useAuth } from "../context/AuthContext";
import { getRideDetails, triggerPanic } from "../services/api";

export default function TrackingScreen({ route }) {
  const { rideId } = route?.params || {};
  const { token } = useAuth();
  const [minsAway, setMinsAway] = useState(12);
  const [panicSending, setPanicSending] = useState(false);
  const [panicActive, setPanicActive] = useState(false);

  // Mock "live" countdown so the screen feels real without a full GPS hookup
  // on this screen specifically — the driver's ACTUAL location (sent from
  // the driver app via PATCH /api/drivers/location) is real; this countdown
  // is just a placeholder for ETA math, which needs a mapping/routing
  // service to compute properly.
  useEffect(() => {
    const id = setInterval(() => {
      setMinsAway((m) => (m > 1 ? m - 1 : m));
    }, 15000);
    return () => clearInterval(id);
  }, []);

  const shareRide = async () => {
    try {
      await Share.share({
        message: "I'm on an RideArrivo trip. Track my live location here: https://arrivo.app/track/DEMO123",
      });
    } catch (e) {
      Alert.alert("Couldn't open share sheet", String(e?.message || e));
    }
  };

  const callDriver = () => {
    // Wire this up to Linking.openURL(`tel:${driverPhone}`) once real driver data exists.
    Alert.alert("Calling driver", "This would open your phone dialer with the driver's masked number.");
  };

  const confirmPanic = () => {
    Alert.alert(
      "Trigger safety alert?",
      "This immediately notifies RideArrivo's support team with your ride details and location. Only use this if you feel unsafe right now.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Yes, alert support", style: "destructive", onPress: sendPanic },
      ]
    );
  };

  const sendPanic = async () => {
    if (!rideId) {
      Alert.alert("Can't send alert", "No active ride found for this session.");
      return;
    }
    setPanicSending(true);
    try {
      await triggerPanic(token, rideId, "Triggered from Live Tracking screen");
      setPanicActive(true);
      Alert.alert(
        "Support has been alerted",
        "Our team has been notified of your ride and location and will reach out. If you're in immediate danger, please also call local emergency services."
      );
    } catch (e) {
      Alert.alert("Couldn't send alert", e.message || "Please try again, or call support directly.");
    } finally {
      setPanicSending(false);
    }
  };

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingBottom: 40 }}>
        <MapPlaceholder etaLabel={`🚗 ${minsAway} min away`} height={220} />

        <Card style={{ marginTop: spacing.md, flexDirection: "row", gap: 12, alignItems: "center" }}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>KJ</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.name}>Kunle J., Toyota Highlander</Text>
            <Text style={styles.meta}>Plate: KJA 224 XL · ★ 4.9</Text>
            <Tag label="ID Verified" tone="teal" />
          </View>
        </Card>

        <View style={styles.grid2}>
          <Button label="📍 Share ride" variant="teal" onPress={shareRide} style={{ flex: 1 }} />
          <Button label="☎ Call driver" variant="ghost" onPress={callDriver} style={{ flex: 1 }} />
        </View>

        <Card style={{ marginTop: spacing.md }}>
          <Text style={styles.shareNote}>
            Sharing live location with <Text style={{ fontWeight: "700" }}>Bimpe A.</Text>
          </Text>
        </Card>

        {panicActive ? (
          <Card style={{ marginTop: spacing.md, borderColor: colors.coral, borderWidth: 1 }}>
            <Text style={styles.panicActiveText}>🚨 Support has been alerted about this ride.</Text>
          </Card>
        ) : (
          <Pressable
            onPress={confirmPanic}
            disabled={panicSending}
            style={({ pressed }) => [styles.panicBtn, (pressed || panicSending) && { opacity: 0.7 }]}
          >
            {panicSending ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.panicText}>🚨 I don't feel safe. Alert support</Text>
            )}
          </Pressable>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  avatar: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: colors.teal,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { color: "#fff", fontWeight: "700" },
  name: { color: colors.ink, fontWeight: "700", fontSize: 14 },
  meta: { color: colors.textMuted, fontSize: 11, marginTop: 2 },
  grid2: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.md },
  shareNote: { color: colors.textMuted, fontSize: 11.5, textAlign: "center" },
  panicBtn: {
    marginTop: spacing.lg,
    backgroundColor: colors.coral,
    borderRadius: radius.sm + 2,
    paddingVertical: 14,
    alignItems: "center",
  },
  panicText: { color: "#fff", fontWeight: "700", fontSize: 13.5 },
  panicActiveText: { color: colors.coral, fontWeight: "700", fontSize: 13, textAlign: "center" },
});
