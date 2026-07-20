import React, { useEffect, useRef, useState, useCallback } from "react";
import { View, Text, StyleSheet, ScrollView, Alert, Share, Pressable, ActivityIndicator, Linking, TextInput } from "react-native";
import { Card, Button, Tag } from "../components/UI";
import { GradientBackground } from "../components/GradientBackground";
import { MapPlaceholder } from "../components/MapPlaceholder";
import { colors, spacing, radius } from "../theme/tokens";
import { useAuth } from "../context/AuthContext";
import { getRideDetails, triggerPanic, rateRide } from "../services/api";

const POLL_INTERVAL_MS = 10000;

const STATUS_LABEL = {
  requested: "Looking for a driver…",
  accepted: "Driver is heading to pickup",
  in_progress: "Trip in progress",
  completed: "Trip completed",
  cancelled: "Trip cancelled",
};

function initials(name) {
  if (!name) return "?";
  return name.trim().split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() || "").join("");
}

export default function TrackingScreen({ route, navigation }) {
  const { rideId } = route?.params || {};
  const { token } = useAuth();
  const [ride, setRide] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [panicSending, setPanicSending] = useState(false);
  const [panicActive, setPanicActive] = useState(false);
  const [starsSelected, setStarsSelected] = useState(0);
  const [ratingComment, setRatingComment] = useState("");
  const [submittingRating, setSubmittingRating] = useState(false);
  const [ratingError, setRatingError] = useState(null);
  const pollRef = useRef(null);

  const fetchRide = useCallback(async () => {
    if (!rideId) return;
    try {
      const { ride: data } = await getRideDetails(token, rideId);
      setRide(data);
      setPanicActive(!!data.panic_triggered_at);
      setLoadError(null);
    } catch (e) {
      setLoadError(e.message || "Couldn't load this ride.");
    } finally {
      setLoading(false);
    }
  }, [token, rideId]);

  // Poll for updates (driver location, status changes) while the trip is
  // still active — no point polling once it's completed/cancelled.
  useEffect(() => {
    fetchRide();
    pollRef.current = setInterval(() => {
      if (ride && ["completed", "cancelled"].includes(ride.ride_status)) return;
      fetchRide();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(pollRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchRide]);

  const shareRide = async () => {
    try {
      const driverPart = ride?.driver_name ? ` with ${ride.driver_name}` : "";
      await Share.share({
        message: `I'm on a RideArrivo trip${driverPart}, heading to ${ride?.stops?.[ride.stops.length - 1] || "my destination"}. Pickup was ${ride?.pickup_address || "—"}.`,
      });
    } catch (e) {
      Alert.alert("Couldn't open share sheet", String(e?.message || e));
    }
  };

  const callDriver = () => {
    if (!ride?.driver_phone) {
      Alert.alert("Not available yet", "Your driver's number will appear here once they've accepted your ride.");
      return;
    }
    Linking.openURL(`tel:${ride.driver_phone}`).catch(() =>
      Alert.alert("Couldn't open dialer", "Please dial the number manually: " + ride.driver_phone)
    );
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

  const submitRating = async () => {
    if (!starsSelected) {
      setRatingError("Tap a star to rate your trip.");
      return;
    }
    setSubmittingRating(true);
    setRatingError(null);
    try {
      await rateRide(token, rideId, starsSelected, ratingComment.trim() || undefined);
      await fetchRide();
    } catch (e) {
      setRatingError(e.message || "Couldn't submit your rating. Please try again.");
    } finally {
      setSubmittingRating(false);
    }
  };

  if (loading) {
    return (
      <View style={styles.screen}>
        <GradientBackground variant="dark" />
        <View style={[StyleSheet.absoluteFill, { alignItems: "center", justifyContent: "center" }]}>
          <ActivityIndicator color={colors.amber} size="large" />
        </View>
      </View>
    );
  }

  const statusLabel = STATUS_LABEL[ride?.ride_status] || "Tracking your ride";
  const hasDriver = !!ride?.driver_name;
  const hasVehicle = !!(ride?.make_model && ride?.plate_number);

  return (
    <View style={styles.screen}>
      <GradientBackground variant="dark" />
      <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingBottom: 40 }}>
        <MapPlaceholder etaLabel={`🚗 ${statusLabel}`} height={220} />

        {loadError ? (
          <Card tone="dark" style={{ marginTop: spacing.md, borderColor: colors.coral, borderWidth: 1 }}>
            <Text style={styles.warningText}>{loadError}</Text>
          </Card>
        ) : null}

        <Card tone="dark" style={{ marginTop: spacing.md }}>
          {/* Card's own style prop only affects the outer clipping wrapper (needed for
              the BlurView), not the inner content area, so row layout has to be applied
              to a real child view here rather than passed into Card's style. */}
          <View style={{ flexDirection: "row", gap: 12, alignItems: "center" }}>
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>{hasDriver ? initials(ride.driver_name) : "…"}</Text>
            </View>
            <View style={{ flex: 1 }}>
              {hasDriver ? (
                <>
                  <Text style={styles.name}>
                    {ride.driver_name}{hasVehicle ? `, ${ride.make_model}` : ""}
                  </Text>
                  <Text style={styles.meta}>
                    {hasVehicle ? `Plate: ${ride.plate_number}` : "Vehicle will be assigned before pickup"}
                    {ride.driver_rating ? ` · ★ ${Number(ride.driver_rating).toFixed(1)}` : ""}
                  </Text>
                  {ride.driver_is_verified ? <Tag label="ID Verified" tone="teal" /> : null}
                </>
              ) : (
                <Text style={styles.meta}>{statusLabel}</Text>
              )}
            </View>
          </View>
        </Card>

        {ride?.ride_status === "completed" && hasDriver ? (
          <Card tone="dark" tinted style={{ marginTop: spacing.md }}>
            <Text style={styles.cardLabel}>Rate & Relax</Text>
            {ride.rider_rating ? (
              <Text style={styles.meta}>
                You rated this trip {"★".repeat(ride.rider_rating)}{"☆".repeat(5 - ride.rider_rating)}
                {ride.rider_rating_comment ? ` — "${ride.rider_rating_comment}"` : ""}
              </Text>
            ) : (
              <>
                <Text style={styles.meta}>How was your trip with {ride.driver_name}?</Text>
                <View style={styles.starRow}>
                  {[1, 2, 3, 4, 5].map((n) => (
                    <Pressable key={n} onPress={() => setStarsSelected(n)} hitSlop={6}>
                      <Text style={styles.starChar}>{n <= starsSelected ? "★" : "☆"}</Text>
                    </Pressable>
                  ))}
                </View>
                <TextInput
                  style={styles.input}
                  value={ratingComment}
                  onChangeText={setRatingComment}
                  placeholder="Add a comment (optional)"
                  placeholderTextColor={colors.dark.textMuted}
                />
                {ratingError ? <Text style={styles.warningText}>{ratingError}</Text> : null}
                <View style={{ height: spacing.sm }} />
                {submittingRating ? (
                  <ActivityIndicator color={colors.amber} />
                ) : (
                  <Button label="Submit rating" variant="ghost" tone="dark" onPress={submitRating} />
                )}
              </>
            )}
          </Card>
        ) : null}

        <View style={styles.grid2}>
          <Button label="📍 Share ride" variant="teal" onPress={shareRide} style={{ flex: 1 }} />
          <Button label="☎ Call driver" variant="ghost" tone="dark" onPress={callDriver} style={{ flex: 1 }} />
        </View>

        {ride?.ride_status === "accepted" ? (
          <Button
            label="📷 Scan driver's QR to start tracking"
            onPress={() => navigation.navigate("Scan")}
            style={{ marginTop: spacing.md }}
            trailingIcon
          />
        ) : null}

        <Card tone="dark" style={{ marginTop: spacing.md }}>
          <Text style={styles.shareNote}>
            {ride?.emergency_contact_name
              ? <>Sharing live location with <Text style={{ fontWeight: "700" }}>{ride.emergency_contact_name}</Text></>
              : "No emergency contact was added for this ride."}
          </Text>
        </Card>

        {panicActive ? (
          <Card tone="dark" style={{ marginTop: spacing.md, borderColor: colors.coral, borderWidth: 1 }}>
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
  screen: { flex: 1, backgroundColor: colors.dark.bg0 },
  avatar: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: colors.teal,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { color: "#fff", fontWeight: "700" },
  name: { color: colors.dark.text, fontWeight: "700", fontSize: 14 },
  meta: { color: colors.dark.textMuted, fontSize: 11, marginTop: 2 },
  cardLabel: { color: colors.dark.text, fontWeight: "700", fontSize: 13, marginBottom: 4 },
  starRow: { flexDirection: "row", gap: 6, marginTop: spacing.sm, marginBottom: spacing.sm },
  starChar: { fontSize: 28, color: colors.amber },
  input: {
    backgroundColor: colors.dark.fieldBg,
    color: colors.dark.text,
    borderRadius: 10,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    fontSize: 13,
  },
  grid2: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.md },
  shareNote: { color: colors.dark.textMuted, fontSize: 11.5, textAlign: "center" },
  warningText: { color: "#FF9B8A", fontSize: 12, textAlign: "center" },
  panicBtn: {
    marginTop: spacing.lg,
    backgroundColor: colors.coral,
    borderRadius: radius.sm + 2,
    paddingVertical: 14,
    alignItems: "center",
  },
  panicText: { color: "#fff", fontWeight: "700", fontSize: 13.5 },
  panicActiveText: { color: "#FF9B8A", fontWeight: "700", fontSize: 13, textAlign: "center" },
});
