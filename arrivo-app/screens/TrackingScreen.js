import React, { useEffect, useState } from "react";
import { View, Text, StyleSheet, ScrollView, Alert, Share } from "react-native";
import { Card, Button, Tag } from "../components/UI";
import { MapPlaceholder } from "../components/MapPlaceholder";
import { colors, spacing, radius } from "../theme/tokens";

export default function TrackingScreen() {
  const [minsAway, setMinsAway] = useState(12);

  // Mock "live" countdown so the screen feels real without a GPS/backend hookup.
  useEffect(() => {
    const id = setInterval(() => {
      setMinsAway((m) => (m > 1 ? m - 1 : m));
    }, 15000);
    return () => clearInterval(id);
  }, []);

  const shareRide = async () => {
    try {
      await Share.share({
        message: "I'm on an Arrivo trip. Track my live location here: https://arrivo.app/track/DEMO123",
      });
    } catch (e) {
      Alert.alert("Couldn't open share sheet", String(e?.message || e));
    }
  };

  const callDriver = () => {
    // Wire this up to Linking.openURL(`tel:${driverPhone}`) once real driver data exists.
    Alert.alert("Calling driver", "This would open your phone dialer with the driver's masked number.");
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
            <Text style={styles.name}>Kunle J. — Toyota Highlander</Text>
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
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.ink },
  avatar: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: colors.teal,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { color: "#fff", fontWeight: "700" },
  name: { color: colors.cream, fontWeight: "700", fontSize: 14 },
  meta: { color: colors.textMuted, fontSize: 11, marginTop: 2 },
  grid2: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.md },
  shareNote: { color: colors.textMuted, fontSize: 11.5, textAlign: "center" },
});
