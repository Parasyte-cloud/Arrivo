import React, { useCallback, useEffect, useRef, useState } from "react";
import { View, Text, StyleSheet, ScrollView, Switch, ActivityIndicator, RefreshControl } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect } from "@react-navigation/native";
import { Card, Button, Tag } from "../components/UI";
import { GradientBackground } from "../components/GradientBackground";
import { LiveMap } from "../components/LiveMap";
import { colors, spacing } from "../theme/tokens";
import { useAuth } from "../context/AuthContext";
import { setOnlineStatus, getAvailableRides, acceptRide, updateRideStatus, getMyDriverRides, triggerPanic, activateListeningDevice } from "../services/api";
import { useLocationReporting } from "../hooks/useLocationReporting";

const POLL_INTERVAL_MS = 8000;

export default function DashboardScreen() {
  const insets = useSafeAreaInsets();
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

  // Keep the active-trip card's data fresh while on a trip — status changes,
  // fare adjustments, or a listening-device activation from another path
  // previously only showed up on tab refocus or a manual pull-to-refresh,
  // which could leave a driver acting on stale trip data for a long time.
  const activeRidePollRef = useRef(null);
  useEffect(() => {
    if (activeRide) {
      activeRidePollRef.current = setInterval(checkForActiveRide, POLL_INTERVAL_MS);
    }
    return () => clearInterval(activeRidePollRef.current);
  }, [activeRide, checkForActiveRide]);

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
      <View style={styles.screen}>
        <GradientBackground variant="dark" />
        <View style={[StyleSheet.absoluteFill, { alignItems: "center", justifyContent: "center" }]}>
          <ActivityIndicator color={colors.amber} size="large" />
        </View>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <GradientBackground variant="dark" />
      <ScrollView
        contentContainerStyle={{ paddingTop: insets.top + spacing.lg, paddingHorizontal: spacing.lg, paddingBottom: 40 }}
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
            trackColor={{ false: "rgba(255,255,255,0.18)", true: colors.amber }}
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
              <Card tone="dark">
                <View style={{ alignItems: "center", paddingVertical: spacing.md }}>
                  <ActivityIndicator color={colors.amber} />
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
          <Card tone="dark">
            <Text style={styles.offlineText}>Go online to start receiving ride requests.</Text>
          </Card>
        )}
      </ScrollView>
    </View>
  );
}

// "dropoff" (Airport Drop-off — taking a departing rider TO the airport) is
// the mirror image of "one_way" (Airport Pickup — an arriving rider FROM
// the airport) — surfaced here so a driver can immediately tell which
// direction a request runs, since the pickup_address/stops alone don't
// make that obvious at a glance.
function tripTypeLabel(bookingType) {
  if (bookingType === "dropoff") return "Airport Drop-off";
  if (bookingType === "one_way") return "Airport Pickup";
  return "Chauffeur";
}

// A "dropoff" ride has no flight-landing event to anchor timing on (unlike
// an arrival pickup), so the rider scheduled an explicit pickup date/time
// instead — shown here so a driver doesn't mistake a next-week booking for
// something needing immediate response. Null for anything not scheduled.
function scheduledLabel(ride) {
  if (!ride.scheduled_pickup_at) return null;
  return new Date(ride.scheduled_pickup_at).toLocaleString([], {
    weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
  });
}

// "The driver has to be there latest 30 minutes to the time" — there's no
// live GPS geofencing in this build to actually enforce that, so this is a
// clear on-screen instruction (backed up by the scheduler's push reminders
// at the 1h/now thresholds — see services/scheduler.js) rather than a hard
// block.
function arriveByLabel(ride) {
  if (!ride.scheduled_pickup_at) return null;
  const arriveBy = new Date(new Date(ride.scheduled_pickup_at).getTime() - 30 * 60 * 1000);
  return arriveBy.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function RequestCard({ ride, busy, onAccept }) {
  const scheduled = scheduledLabel(ride);
  const arriveBy = arriveByLabel(ride);
  return (
    <Card tone="dark" style={{ marginBottom: spacing.sm }}>
      <View style={styles.rowBetween}>
        <Tag label={tripTypeLabel(ride.booking_type)} tone={ride.booking_type === "dropoff" ? "amber" : "teal"} />
        <Text style={styles.fare}>₦{ride.fare_naira?.toLocaleString()}</Text>
      </View>
      {/* is_preferred_for_you comes from GET /available — set when this
          rider asked to keep the same driver for their return trip and this
          ride is currently held exclusively for this driver (see
          routes/rides.js and services/scheduler.js's claim-window expiry). */}
      {ride.is_preferred_for_you ? <Tag label="⭐ Your regular rider" tone="amber" /> : null}
      <Text style={styles.tripTitle}>{ride.pickup_address}</Text>
      {scheduled ? <Text style={styles.scheduledText}>📅 Scheduled: {scheduled}</Text> : null}
      {arriveBy ? <Text style={styles.scheduledText}>⏰ Please arrive by {arriveBy} (30 min early)</Text> : null}
      {ride.flight_number ? <Tag label={`Flight ${ride.flight_number}`} tone="teal" /> : null}
      {ride.stops?.length ? <Text style={styles.meta}>→ {ride.stops.join(", ")}</Text> : null}
      <Text style={styles.meta}>Rider: {ride.rider_name}</Text>
      <View style={{ height: spacing.sm }} />
      {busy ? <ActivityIndicator color={colors.amber} /> : <Button label="Accept Ride" onPress={onAccept} trailingIcon />}
    </Card>
  );
}

function ActiveTripCard({ ride, busy, onAdvance, token }) {
  const isAccepted = ride.ride_status === "accepted";
  const isInProgress = ride.ride_status === "in_progress";
  // "Reserve now, pay at pickup" was removed as a product decision — every
  // ride is now paid in full at booking, so no ride created going forward
  // will ever match this. Left in place only so any ride that was already
  // reserved-unpaid before that change shipped still shows a clear message
  // here instead of a raw rejection error when Start Trip is tapped (the
  // backend independently blocks the transition either way — see
  // arrivo-backend/routes/rides.js PATCH /:id/status).
  const awaitingRiderPayment =
    isAccepted && !!ride.pay_at_pickup && ride.payment_method === "wallet" && ride.payment_status !== "paid";

  const [panicState, setPanicState] = useState("idle"); // idle | counting | active
  const [countdown, setCountdown] = useState(3);
  const countdownRef = useRef(null);
  // True once the panic POST has actually been confirmed by the server —
  // separate from panicState so the UI can distinguish "we think this
  // fired but haven't confirmed it" from "confirmed." Was previously
  // implicit/assumed the moment the countdown hit zero, which meant a
  // failed network call still showed full "alert active, help is coming"
  // confidence to the driver with nobody actually notified.
  const [panicConfirmed, setPanicConfirmed] = useState(false);
  const [panicError, setPanicError] = useState(false);
  // One-way, matches ridearrivo.com — starts "on" if the ride already shows
  // an activation (e.g. app reopened mid-trip), otherwise idle. No control
  // to turn it back off, same as panic.
  const [listeningOn, setListeningOn] = useState(!!ride.listening_device_activated_at);
  const [listeningError, setListeningError] = useState(false);

  const sendPanicRequest = () => {
    setPanicError(false);
    triggerPanic(token, ride.id, "Driver-initiated SOS")
      .then(() => setPanicConfirmed(true))
      .catch(() => setPanicError(true));
    // "One trigger, full response" — panic already activates the listening
    // device server-side in the same write on success, so reflect that in
    // the UI optimistically; if the panic call itself fails, activateListening
    // below still gives an independent way to confirm/retry it.
    setListeningOn(true);
  };

  const startPanicCountdown = () => {
    setPanicState("counting");
    setCountdown(3);
    countdownRef.current = setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) {
          clearInterval(countdownRef.current);
          sendPanicRequest();
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

  const activateListening = () => {
    setListeningOn(true); // optimistic, but listeningError below keeps this honest
    setListeningError(false);
    activateListeningDevice(token, ride.id).catch(() => setListeningError(true));
  };

  useEffect(() => {
    if (countdown === 0 && panicState === "counting") setPanicState("active");
  }, [countdown, panicState]);

  // ActiveTripCard isn't remounted while a trip stays active (no `key` prop
  // and `ride` only ever changes via re-render), so listeningOn previously
  // only reflected whatever ride.listening_device_activated_at was at the
  // very first render. Now that the parent polls the active ride (see
  // DashboardScreen above), this keeps it in sync with the server — e.g. if
  // it was activated from another device/session. One-way only, matching
  // the rest of this feature: never flips back to false.
  useEffect(() => {
    if (ride.listening_device_activated_at) setListeningOn(true);
  }, [ride.listening_device_activated_at]);

  useEffect(() => () => clearInterval(countdownRef.current), []);

  return (
    <View>
      <LiveMap
        pickup={ride.pickup_lat != null ? { lat: Number(ride.pickup_lat), lng: Number(ride.pickup_lng) } : null}
        destination={ride.destination_lat != null ? { lat: Number(ride.destination_lat), lng: Number(ride.destination_lng) } : null}
        etaLabel={isInProgress ? "Trip in progress" : "Heading to pickup"}
        height={170}
      />
      <Card tone="dark" style={{ marginTop: spacing.md }}>
        <View style={styles.rowBetween}>
          <Tag label={ride.ride_status.replace("_", " ").toUpperCase()} tone={isInProgress ? "teal" : "amber"} />
          <Text style={styles.fare}>₦{ride.fare_naira?.toLocaleString()}</Text>
        </View>
        <Text style={styles.tripTitle}>{ride.pickup_address}</Text>
        <View style={{ marginTop: 4, alignSelf: "flex-start" }}>
          <Tag label={tripTypeLabel(ride.booking_type)} tone={ride.booking_type === "dropoff" ? "amber" : "teal"} />
        </View>
        {scheduledLabel(ride) ? <Text style={styles.scheduledText}>📅 Scheduled: {scheduledLabel(ride)}</Text> : null}
        {arriveByLabel(ride) ? <Text style={styles.scheduledText}>⏰ Please arrive by {arriveByLabel(ride)} (30 min early)</Text> : null}
        {ride.stops?.length ? <Text style={styles.meta}>→ {ride.stops.join(", ")}</Text> : null}
        {ride.flight_number ? <Text style={styles.meta}>Flight {ride.flight_number}</Text> : null}
        <Text style={styles.meta}>Rider: {ride.rider_name}{ride.rider_phone ? ` · ${ride.rider_phone}` : ""}</Text>
      </Card>

      <View style={{ height: spacing.md }} />

      {panicState === "active" ? (
        <Card tone="dark" style={styles.panicActiveCard}>
          <Text style={styles.panicActiveTitle}>Emergency alert active</Text>
          <Text style={styles.panicActiveBody}>
            {panicConfirmed
              ? "Our team has been notified and is monitoring this trip. This can only be cleared once resolved on our end."
              : "Sending to RideArrivo's team…"}
          </Text>
          {panicError ? (
            <>
              <Text style={styles.panicErrorText}>
                Couldn't confirm this reached RideArrivo's servers. Please also call support directly if you're in danger.
              </Text>
              <Button label="Retry sending alert" variant="ghost" tone="dark" onPress={sendPanicRequest} style={{ marginTop: 8 }} />
            </>
          ) : null}
        </Card>
      ) : panicState === "counting" ? (
        <Card tone="dark" style={styles.panicCountingCard}>
          <Text style={styles.panicCountingText}>Sending emergency alert in {countdown}…</Text>
          <Button label="Cancel" variant="ghost" tone="dark" onPress={cancelPanicCountdown} style={{ marginTop: 8 }} />
        </Card>
      ) : (
        <Button label="Emergency SOS" variant="ghost" tone="dark" style={styles.sosButton} onPress={startPanicCountdown} />
      )}

      <View style={{ height: spacing.sm }} />

      {listeningOn ? (
        <>
          <Text style={styles.listeningOnText}>🎙️ Listening device: on</Text>
          {listeningError ? (
            <Button label="Couldn't confirm — tap to retry" variant="ghost" tone="dark" onPress={activateListening} style={{ marginTop: 6 }} />
          ) : null}
        </>
      ) : (
        <Button label="🎙️ Activate listening device" variant="ghost" tone="dark" onPress={activateListening} />
      )}

      <View style={{ height: spacing.sm }} />

      {busy ? (
        <ActivityIndicator color={colors.amber} />
      ) : awaitingRiderPayment ? (
        <>
          <Text style={styles.awaitingPaymentText}>
            ⏳ This rider reserved and pays at pickup. Ask them to scan your QR placard to pay and start the trip.
          </Text>
          <View style={{ height: spacing.sm }} />
          <Button label="Cancel Trip" variant="ghost" tone="dark" onPress={() => onAdvance("cancelled")} />
        </>
      ) : isAccepted ? (
        <>
          <Button label="Start Trip" onPress={() => onAdvance("in_progress")} trailingIcon />
          <View style={{ height: spacing.sm }} />
          <Button label="Cancel Trip" variant="ghost" tone="dark" onPress={() => onAdvance("cancelled")} />
        </>
      ) : (
        <Button label="Complete Trip" onPress={() => onAdvance("completed")} trailingIcon />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.dark.bg0 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: spacing.lg },
  greet: { fontSize: 19, fontWeight: "700", color: colors.dark.text },
  sub: { fontSize: 12, color: colors.dark.textMuted, marginTop: 2 },
  sectionLabel: { color: colors.dark.textMuted, fontSize: 12, fontWeight: "600", marginBottom: spacing.sm, textTransform: "uppercase", letterSpacing: 0.5 },
  waitingText: { color: colors.dark.textMuted, fontSize: 12.5, marginTop: 8 },
  offlineText: { color: colors.dark.textMuted, fontSize: 13, textAlign: "center", paddingVertical: spacing.md },
  rowBetween: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" },
  tripTitle: { color: colors.dark.text, fontSize: 14, fontWeight: "700", marginTop: 4 },
  fare: { color: colors.amber, fontSize: 15, fontWeight: "700" },
  meta: { color: colors.dark.textMuted, fontSize: 11.5, marginTop: 4 },
  scheduledText: { color: colors.amber, fontSize: 11.5, fontWeight: "600", marginTop: 4 },
  error: { color: "#FF9B8A", fontSize: 12, marginBottom: spacing.md, textAlign: "center" },
  sosButton: { borderColor: colors.coral, borderWidth: 1.5 },
  panicCountingCard: { backgroundColor: "rgba(225,82,61,0.18)", borderColor: colors.coral, borderWidth: 1 },
  panicCountingText: { color: "#FF9B8A", fontSize: 13, fontWeight: "700" },
  panicActiveCard: { backgroundColor: "rgba(225,82,61,0.22)", borderColor: colors.coral, borderWidth: 1 },
  panicActiveTitle: { color: "#FF9B8A", fontSize: 14, fontWeight: "700", marginBottom: 4 },
  panicActiveBody: { color: colors.dark.text, fontSize: 12, lineHeight: 17 },
  panicErrorText: { color: "#FF9B8A", fontSize: 11.5, fontWeight: "600", marginTop: 8, lineHeight: 16 },
  listeningOnText: { color: colors.dark.textMuted, fontSize: 12.5, fontWeight: "600", textAlign: "center" },
  awaitingPaymentText: { color: colors.amber, fontSize: 12.5, fontWeight: "600", textAlign: "center", lineHeight: 18 },
});
