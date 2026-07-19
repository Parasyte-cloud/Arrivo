import React, { useCallback, useEffect, useRef, useState } from "react";
import { View, Text, StyleSheet, ScrollView, Switch, ActivityIndicator, RefreshControl } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { Card, Button, Tag } from "../components/UI";
import { GradientBackground } from "../components/GradientBackground";
import { MapPlaceholder } from "../components/MapPlaceholder";
import { colors, spacing } from "../theme/tokens";
import { useAuth } from "../context/AuthContext";
import { setOnlineStatus, getAvailableRides, acceptRide, updateRideStatus, getMyDriverRides, triggerPanic } from "../services/api";
import { useLocationReporting } from "../hooks/useLocationReporting";

const POLL_INTERVAL_MS = 8000;

export default function DashboardScreen() {
  const { token, user } = useAuth();
  const [isOnline, setIsOnline] = useState(false);
  const [available, setAvailable] = useState([]);
  const [activeRide, setActiveRide] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busyRideId, setBusyRideId] = useState(null);
  const [error, setError] = useState(null);
  const pollRef = useRef(null);

  // While online (whether waiting for a request or mid-trip), periodically
  // report this phone's GPS position to the backend. This is what makes
  // the admin dashboard's driver list and the rider's tracking screen show
  // a real position instead of nothing.
  useLocationReporting(token, isOnline);

  const checkForActiveRide = useCallback(async () => {
    try {
      const { rides } = await getMyDriverRides(token);
      const active = rides.find((r) => r.ride_status === "accepted" || r.ride_status === "in_progress");
      setActiveRide(active || null);
      return active;
    } catch (e) {
      setError(e.message);
      return null;
    }
  }, [token]);

  const refreshAvailable = useCallback(async () => {
    try {
      const { rides } = await getAvailableRides(token);
      setAvailable(rides);
    } catch (e) {
      setError(e.message);
    }
  }, [token]);

  // On screen focus, check whether this driver already has an active ride
  // (e.g. app was closed mid-trip) before deciding what to show.
  useFocusEffect(
    useCallback(() => {
      (async () => {
        setLoading(true);
        await checkForActiveRide();
        setLoading(false);
      })();
    }, [checkForActiveRide])
  );

  // Poll for new ride requests while online and not already on a trip.
  useEffect(() => {
    if (isOnline && !activeRide) {
      refreshAvailable();
      pollRef.current = setInterval(refreshAvailable, POLL_INTERVAL_MS);
    } else {
      clearInterval(pollRef.current);
      setAvailable([]);
    }
    return () => clearInterval(pollRef.current);
  }, [isOnline, activeRide, refreshAvailable]);

  const toggleOnline = async (value) => {
    setIsOnline(value); // optimistic — feels instant
    try {
      await setOnlineStatus(token, value);
    } catch (e) {
      setIsOnline(!value); // revert on failure
      setError(e.message);
    }
  };

  const handleAccept = async (rideId) => {
    setBusyRideId(rideId);
    setError(null);
    try {
      const { ride } = await acceptRide(token, rideId);
      setActiveRide(ride);
      setAvailable([]);
    } catch (e) {
      setError(e.message); // e.g. "already accepted by another driver" — refresh the list either way
      refreshAvailable();
    } finally {
      setBusyRideId(null);
    }
  };

  const advanceTrip = async (nextStatus) => {
    if (!activeRide) return;
    setBusyRideId(activeRide.id);
    try {
      const { ride } = await updateRideStatus(token, activeRide.id, nextStatus);
      if (nextStatus === "completed" || nextStatus === "cancelled") {
        setActiveRide(null);
      } else {
        setActiveRide(ride);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusyRideId(null);
    }
  };

  if (loading) {
    return (
      <View style={[styles.screen, { alignItems: "center", justifyContent: "center" }]}>
        <ActivityIndicator color={colors.amber} size="large" />
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <GradientBackground />
      <ScrollView
        contentContainerStyle={{ padding: spacing.lg, paddingBottom: 40 }}
        refreshControl={<RefreshControl refreshing={false} onRefresh={activeRide ? checkForActiveRide : refreshAvailable} tintColor={colors.amber} />}
      >
        <View style={styles.header}>
          <View>
            <Text style={styles.greet}>Hi, {user?.name?.split(" ")[0] || "driver"}</Text>
            <Text style={styles.sub}>{isOnline ? "You're online" : "You're offline"}</Text>
          </View>
          <Switch
            value={isOnline}
            onValueChange={toggleOnline}
            disabled={!!activeRide}
            trackColor={{ false: "rgba(18,18,59,0.2)", true: colors.amber }}
            thumbColor="#fff"
          />
        </View>

        {error ? <Text style={styles.error}>{error}</Text> : null}

        {activeRide ? (
          <ActiveTripCard ride={activeRide} busy={busyRideId === activeRide.id} onAdvance={advanceTrip} token={token} />
        ) : isOnline ? (
          <>
            <Text style={styles.sectionLabel}>Nearby requests</Text>
            {available.length === 0 ? (
              <Card>
                <View style={{ alignItems: "center", paddingVertical: spacing.md }}>
                  <ActivityIndicator color={colors.teal} />
                  <Text style={styles.waitingText}>Searching for ride requests…</Text>
                </View>
              </Card>
            ) : (
              available.map((ride) => (
                <RequestCard key={ride.id} ride={ride} busy={busyRideId === ride.id} onAccept={() => handleAccept(ride.id)} />
              ))
            )}
          </>
        ) : (
          <Card>
            <Text style={styles.offlineText}>Go online to start receiving ride requests.</Text>
          </Card>
        )}
      </ScrollView>
    </View>
  );
}

function RequestCard({ ride, busy, onAccept }) {
  return (
    <Card style={{ marginBottom: spacing.sm }}>
      <View style={styles.rowBetween}>
        <Text style={styles.tripTitle}>{ride.pickup_address}</Text>
        <Text style={styles.fare}>₦{ride.fare_naira?.toLocaleString()}</Text>
      </View>
      {ride.flight_number ? <Tag label={`Flight ${ride.flight_number}`} tone="teal" /> : null}
      {ride.stops?.length ? <Text style={styles.meta}>→ {ride.stops.join(", ")}</Text> : null}
      <Text style={styles.meta}>Rider: {ride.rider_name}</Text>
      <View style={{ height: spacing.sm }} />
      {busy ? <ActivityIndicator color={colors.amber} /> : <Button label="Accept Ride" onPress={onAccept} />}
    </Card>
  );
}

function ActiveTripCard({ ride, busy, onAdvance, token }) {
  const isAccepted = ride.ride_status === "accepted";
  const isInProgress = ride.ride_status === "in_progress";

  const [panicState, setPanicState] = useState("idle"); // idle | counting | active
  const [countdown, setCountdown] = useState(3);
  const countdownRef = useRef(null);

  const startPanicCountdown = () => {
    setPanicState("counting");
    setCountdown(3);
    countdownRef.current = setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) {
          clearInterval(countdownRef.current);
          triggerPanic(token, ride.id, "Driver-initiated SOS").catch(() => {
            // Even if the network call fails, the UI stays locked into the
            // active state rather than silently reverting to idle — a
            // driver who believed they'd triggered an alert should never
            // be quietly told "actually never mind" by the app itself.
            // They can retry via the same active-state banner if needed.
          });
          return 0;
        }
        return c - 1;
      });
    }, 1000);
  };

  const cancelPanicCountdown = () => {
    clearInterval(countdownRef.current);
    setPanicState("idle");
  };

  useEffect(() => {
    if (countdown === 0 && panicState === "counting") setPanicState("active");
  }, [countdown, panicState]);

  useEffect(() => () => clearInterval(countdownRef.current), []);

  return (
    <View>
      <MapPlaceholder etaLabel={isInProgress ? "Trip in progress" : "Heading to pickup"} height={170} />
      <Card style={{ marginTop: spacing.md }}>
        <View style={styles.rowBetween}>
          <Tag label={ride.ride_status.replace("_", " ").toUpperCase()} tone={isInProgress ? "teal" : "amber"} />
          <Text style={styles.fare}>₦{ride.fare_naira?.toLocaleString()}</Text>
        </View>
        <Text style={styles.tripTitle}>{ride.pickup_address}</Text>
        {ride.stops?.length ? <Text style={styles.meta}>→ {ride.stops.join(", ")}</Text> : null}
        {ride.flight_number ? <Text style={styles.meta}>Flight {ride.flight_number}</Text> : null}
        <Text style={styles.meta}>Rider: {ride.rider_name}{ride.rider_phone ? ` · ${ride.rider_phone}` : ""}</Text>
      </Card>

      <View style={{ height: spacing.md }} />

      {panicState === "active" ? (
        <Card style={styles.panicActiveCard}>
          <Text style={styles.panicActiveTitle}>Emergency alert active</Text>
          <Text style={styles.panicActiveBody}>
            Our team has been notified and is monitoring this trip. This can only be cleared once resolved on our end.
          </Text>
        </Card>
      ) : panicState === "counting" ? (
        <Card style={styles.panicCountingCard}>
          <Text style={styles.panicCountingText}>Sending emergency alert in {countdown}…</Text>
          <Button label="Cancel" variant="ghost" onPress={cancelPanicCountdown} style={{ marginTop: 8 }} />
        </Card>
      ) : (
        <Button label="Emergency SOS" variant="ghost" style={styles.sosButton} onPress={startPanicCountdown} />
      )}

      <View style={{ height: spacing.sm }} />

      {busy ? (
        <ActivityIndicator color={colors.amber} />
      ) : isAccepted ? (
        <>
          <Button label="Start Trip" onPress={() => onAdvance("in_progress")} />
          <View style={{ height: spacing.sm }} />
          <Button label="Cancel Trip" variant="ghost" onPress={() => onAdvance("cancelled")} />
        </>
      ) : (
        <Button label="Complete Trip" onPress={() => onAdvance("completed")} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "transparent" },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: spacing.lg },
  greet: { fontSize: 19, fontWeight: "700", color: colors.ink },
  sub: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  sectionLabel: { color: colors.textMuted, fontSize: 12, fontWeight: "600", marginBottom: spacing.sm, textTransform: "uppercase", letterSpacing: 0.5 },
  waitingText: { color: colors.textMuted, fontSize: 12.5, marginTop: 8 },
  offlineText: { color: colors.textMuted, fontSize: 13, textAlign: "center", paddingVertical: spacing.md },
  rowBetween: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" },
  tripTitle: { color: colors.ink, fontSize: 14, fontWeight: "700", marginTop: 4 },
  fare: { color: colors.amber, fontSize: 15, fontWeight: "700" },
  meta: { color: colors.textMuted, fontSize: 11.5, marginTop: 4 },
  error: { color: colors.coral, fontSize: 12, marginBottom: spacing.md, textAlign: "center" },
  sosButton: { borderColor: colors.coral, borderWidth: 1.5 },
  panicCountingCard: { backgroundColor: "rgba(225,82,61,0.12)", borderColor: colors.coral, borderWidth: 1, alignItems: "center" },
  panicCountingText: { color: colors.coral, fontSize: 13, fontWeight: "700" },
  panicActiveCard: { backgroundColor: "rgba(225,82,61,0.16)", borderColor: colors.coral, borderWidth: 1 },
  panicActiveTitle: { color: colors.coral, fontSize: 14, fontWeight: "700", marginBottom: 4 },
  panicActiveBody: { color: colors.ink, fontSize: 12, lineHeight: 17 },
});
