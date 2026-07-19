import React, { useCallback, useState } from "react";
import { View, Text, StyleSheet, ScrollView, ActivityIndicator, RefreshControl } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { Card } from "../components/UI";
import { colors, spacing } from "../theme/tokens";
import { useAuth } from "../context/AuthContext";
import { getEarnings, getMyDriverRides } from "../services/api";

export default function EarningsScreen() {
  const { token } = useAuth();
  const [summary, setSummary] = useState(null);
  const [rides, setRides] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const [earnings, history] = await Promise.all([getEarnings(token), getMyDriverRides(token)]);
      setSummary(earnings);
      setRides(history.rides.filter((r) => r.ride_status === "completed"));
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [token]);

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
        <Text style={styles.title}>Earnings</Text>

        {loading && !summary ? <ActivityIndicator color={colors.amber} /> : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}

        {summary ? (
          <Card tinted style={{ marginBottom: spacing.md }}>
            <View style={styles.statsRow}>
              <View>
                <Text style={[styles.statNum, { color: colors.amber }]}>₦{summary.thisMonthNaira?.toLocaleString()}</Text>
                <Text style={styles.statLabel}>This month</Text>
              </View>
              <View>
                <Text style={styles.statNum}>{summary.completedTrips}</Text>
                <Text style={styles.statLabel}>Completed trips</Text>
              </View>
              <View>
                <Text style={styles.statNum}>₦{summary.totalNaira?.toLocaleString()}</Text>
                <Text style={styles.statLabel}>All-time</Text>
              </View>
            </View>
          </Card>
        ) : null}

        <Text style={styles.sectionLabel}>Recent completed trips</Text>
        {rides.length === 0 && !loading ? <Text style={styles.empty}>No completed trips yet.</Text> : null}
        {rides.map((ride) => (
          <Card key={ride.id} style={{ marginBottom: spacing.sm }}>
            <View style={styles.row}>
              <View style={{ flex: 1 }}>
                <Text style={styles.tripTitle}>{ride.pickup_address}</Text>
                <Text style={styles.tripDate}>{new Date(ride.created_at).toLocaleDateString()} · {ride.rider_name}</Text>
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
  screen: { flex: 1, backgroundColor: colors.bg },
  title: { fontSize: 19, fontWeight: "700", color: colors.ink, marginBottom: spacing.md },
  statsRow: { flexDirection: "row", justifyContent: "space-between" },
  statNum: { fontSize: 18, fontWeight: "700", color: colors.ink },
  statLabel: { fontSize: 10, color: colors.textMuted, marginTop: 2 },
  sectionLabel: { color: colors.textMuted, fontSize: 12, fontWeight: "600", marginBottom: spacing.sm, textTransform: "uppercase", letterSpacing: 0.5 },
  row: { flexDirection: "row", alignItems: "center" },
  tripTitle: { color: colors.ink, fontSize: 13, fontWeight: "600" },
  tripDate: { color: colors.textMuted, fontSize: 11, marginTop: 2 },
  tripPrice: { color: colors.ink, fontSize: 13, fontWeight: "700" },
  error: { color: colors.coral, fontSize: 12.5, marginBottom: spacing.md, textAlign: "center" },
  empty: { color: colors.textMuted, fontSize: 13, textAlign: "center", marginTop: spacing.lg },
});
