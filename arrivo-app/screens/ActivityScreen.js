import React, { useCallback, useState } from "react";
import { View, Text, StyleSheet, ScrollView, RefreshControl, ActivityIndicator, Pressable } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect } from "@react-navigation/native";
import { Card } from "../components/UI";
import { GradientBackground } from "../components/GradientBackground";
import { colors, spacing } from "../theme/tokens";
import { useAuth } from "../context/AuthContext";
import { getRideHistory, getSharedWithMeRides, getServiceRequests } from "../services/api";
import ParasyteSignature from "../components/ParasyteSignature";
import { REQUEST_TIERS, statusInfo } from "../tiers/requestTiers";
import { formatLagos } from "../utils/lagosTime";
import { useCurrency } from "../hooks/useCurrency";

export default function ActivityScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const { token } = useAuth();
  const { formatRideFare } = useCurrency(token);
  const [rides, setRides] = useState([]);
  // Arrivo Express Phase 3 -- Arrivo Share. Rides booked and paid for by
  // someone else, where you were added as a co-rider (see
  // POST /:id/share-participants) -- shown separately since you can track
  // these but didn't book or pay for them.
  const [sharedRides, setSharedRides] = useState([]);
  // ArrivoAir, ArrivoBoat and ArrivoRemovals requests. Kept separate from rides
  // because they are confirmed by our team first. A failure to load them never
  // hides the rides list.
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const [data, sharedData] = await Promise.all([getRideHistory(token), getSharedWithMeRides(token)]);
      setRides(data.rides || []);
      setSharedRides(sharedData.rides || []);
      setError(null);
      try {
        const reqData = await getServiceRequests(token);
        setRequests(reqData.requests || []);
      } catch (_) {
        // Requests are secondary here, leave whatever was already shown.
      }
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
      <GradientBackground variant="dark" />
      <ScrollView
        contentContainerStyle={{ paddingTop: insets.top + spacing.lg, paddingHorizontal: spacing.lg, paddingBottom: 40 }}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={colors.amber} />}
      >
        <Text style={styles.title}>Activity</Text>

        {loading && rides.length === 0 ? <ActivityIndicator color={colors.amber} /> : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {!loading && !error && rides.length === 0 && requests.length === 0 ? (
          <Text style={styles.empty}>No rides yet. Book your first airport pickup from Home.</Text>
        ) : null}

        {requests.length > 0 ? (
          <>
            <Text style={styles.sectionTitle}>Requests</Text>
            {requests.map((r) => (
              <Pressable
                key={`req-${r.id}`}
                onPress={() => navigation.navigate("Home", { screen: "RequestStatus", params: { requestId: r.id } })}
                accessibilityRole="button"
              >
                <Card tone="dark" style={{ marginBottom: spacing.sm }}>
                  <View style={styles.row}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.tripTitle}>{REQUEST_TIERS[r.tier] ? REQUEST_TIERS[r.tier].label : "Request"}: {r.pickupAddress}</Text>
                      <Text style={styles.tripDate}>{formatLagos(r.requestedAt)} {"\u00B7"} {statusInfo(r.status).label}</Text>
                    </View>
                  </View>
                </Card>
              </Pressable>
            ))}
            {rides.length > 0 ? <Text style={styles.sectionTitle}>Rides</Text> : null}
          </>
        ) : null}

        {rides.map((ride) => (
          <Pressable
            key={ride.id}
            onPress={() => navigation.navigate("Home", { screen: "Tracking", params: { rideId: ride.id } })}
          >
            <Card tone="dark" style={{ marginBottom: spacing.sm }}>
              <View style={styles.row}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.tripTitle}>
                    {ride.pickup_address}
                    {ride.is_arrivo_share ? " · Arrivo Share" : ""}
                  </Text>
                  <Text style={styles.tripDate}>
                    {new Date(ride.created_at).toLocaleDateString()} · {ride.ride_status} · {ride.payment_status}
                    {ride.ride_status === "completed" && !ride.rider_rating ? " · tap to rate" : ""}
                  </Text>
                </View>
                <Text style={styles.tripPrice}>{formatRideFare(ride.fare_naira, ride.quoted_usd_amount)}</Text>
              </View>
            </Card>
          </Pressable>
        ))}

        {sharedRides.length > 0 ? (
          <>
            <Text style={styles.sectionTitle}>Rides you're sharing</Text>
            {sharedRides.map((ride) => (
              <Pressable
                key={`shared-${ride.id}`}
                onPress={() => navigation.navigate("Home", { screen: "Tracking", params: { rideId: ride.id } })}
              >
                <Card tone="dark" style={{ marginBottom: spacing.sm }}>
                  <View style={styles.row}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.tripTitle}>{ride.pickup_address}</Text>
                      <Text style={styles.tripDate}>
                        Booked by {ride.rider_name} · {new Date(ride.created_at).toLocaleDateString()} · {ride.ride_status}
                      </Text>
                    </View>
                  </View>
                </Card>
              </Pressable>
            ))}
          </>
        ) : null}

        <ParasyteSignature />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.dark.bg0 },
  title: { fontSize: 19, fontWeight: "700", color: colors.dark.text, marginBottom: spacing.md },
  sectionTitle: { fontSize: 15, fontWeight: "700", color: colors.dark.text, marginTop: spacing.md, marginBottom: spacing.sm },
  row: { flexDirection: "row", alignItems: "center" },
  tripTitle: { color: colors.dark.text, fontSize: 13, fontWeight: "600" },
  tripDate: { color: colors.dark.textMuted, fontSize: 11, marginTop: 2 },
  tripPrice: { color: colors.dark.text, fontSize: 13, fontWeight: "700" },
  error: { color: "#FF9B8A", fontSize: 12.5, marginBottom: spacing.md },
  empty: { color: colors.dark.textMuted, fontSize: 13, textAlign: "center", marginTop: spacing.xl },
});
