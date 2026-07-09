import React, { useCallback, useState } from "react";
import { View, Text, StyleSheet, ScrollView, RefreshControl, ActivityIndicator } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { Card } from "../components/UI";
import { colors, spacing } from "../theme/tokens";
import { useAuth } from "../context/AuthContext";
import { getRideHistory } from "../services/api";

export default function ActivityScreen() {
  const { token } = useAuth();
  const [rides, setRides] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const data = await getRideHistory(token);
      setRides(data.rides || []);
      setError(null);
    } catch (e) {
      setError(e.message || "Couldn't load your ride history.");
    } finally {
      setLoading(false);
    }
  }, [token]);

  // Refetch every time this tab comes into focus, so a ride just booked shows up immediately.
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  return (
    <View style={styles.screen}>
      <ScrollView
        contentContainerStyle={{ padding: spacing.lg, paddingBottom: 40 }}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={colors.amber} />}
      >
        <Text style={styles.title}>Activity</Text>

        {loading && rides.length === 0 ? <ActivityIndicator color={colors.amber} /> : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {!loading && !error && rides.length === 0 ? (
          <Text style={styles.empty}>No rides yet — book your first airport pickup from Home.</Text>
        ) : null}

        {rides.map((ride) => (
          <Card key={ride.id} style={{ marginBottom: spacing.sm }}>
            <View style={styles.row}>
              <View style={{ flex: 1 }}>
                <Text style={styles.tripTitle}>{ride.pickup_address}</Text>
                <Text style={styles.tripDate}>
                  {new Date(ride.created_at).toLocaleDateString()} · {ride.ride_status} · {ride.payment_status}
                </Text>
              </View>
              <Text style={styles.tripPrice}>₦{ride.fare_naira?.toLocaleString()}</Text>
            </View>
          </Card>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.ink },
  title: { fontSize: 19, fontWeight: "700", color: colors.cream, marginBottom: spacing.md },
  row: { flexDirection: "row", alignItems: "center" },
  tripTitle: { color: colors.cream, fontSize: 13, fontWeight: "600" },
  tripDate: { color: colors.textMuted, fontSize: 11, marginTop: 2 },
  tripPrice: { color: colors.cream, fontSize: 13, fontWeight: "700" },
  error: { color: colors.coral, fontSize: 12.5, marginBottom: spacing.md },
  empty: { color: colors.textMuted, fontSize: 13, textAlign: "center", marginTop: spacing.xl },
});
