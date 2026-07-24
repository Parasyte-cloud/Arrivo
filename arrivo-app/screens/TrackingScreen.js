import React, { useEffect, useRef, useState, useCallback } from "react";
import { View, Text, StyleSheet, ScrollView, Alert, Share, Pressable, ActivityIndicator, Linking, TextInput, AppState, KeyboardAvoidingView, Platform } from "react-native";
import { Card, Button, Tag } from "../components/UI";
import { GradientBackground } from "../components/GradientBackground";
import { LiveMap } from "../components/LiveMap";
import { colors, spacing, radius } from "../theme/tokens";
import { useAuth } from "../context/AuthContext";
import { useCurrency } from "../hooks/useCurrency";
import {
  getRideDetails, triggerPanic, activateListeningDevice, rateRide, getFlightStatus,
  tipRide, getWallet, initializePayment, verifyPayment, getWalletMinimum, payRideOverage,
  scanRideQr, isNetworkError, getRideShareLink,
} from "../services/api";
import { cacheActiveRide, clearCachedActiveRide, getPendingScan, clearPendingScan } from "../services/rideCache";

// Preset tip percentages, applied against the ride's fare — plus a custom
// amount option for anyone who wants a specific number instead.
const TIP_PERCENTS = [15, 20, 25];

const POLL_INTERVAL_MS = 10000;
// Flight status is refreshed far less often than driver location/ride
// status — it's a paid third-party lookup (aviationstack), not something
// that needs 10-second freshness the way "where's my driver" does.
const FLIGHT_POLL_INTERVAL_MS = 120000;

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
  const { rideId, offlinePending, offlineDriverInfo, offlineRideSummary } = route?.params || {};
  const { user, token } = useAuth();
  const { formatFare } = useCurrency(token);
  // Offline scan fallback (see ScanScreen.js): when a scan couldn't reach
  // the server, we still know — from the QR code itself, plus whatever ride
  // was last cached while online — enough to show "this is your ride, this
  // is your driver" instantly, with zero network dependency. This seeds
  // `ride` with that info immediately instead of showing a spinner while a
  // network request that has no signal to complete over just hangs.
  const [ride, setRide] = useState(() => {
    if (!offlinePending) return null;
    return {
      id: rideId,
      ride_status: (offlineRideSummary && offlineRideSummary.rideStatus) || "accepted",
      driver_name: (offlineDriverInfo && offlineDriverInfo.name) || (offlineRideSummary && offlineRideSummary.driverName) || null,
      make_model: (offlineDriverInfo && offlineDriverInfo.vehicle) || (offlineRideSummary && offlineRideSummary.makeModel) || null,
      plate_number: (offlineDriverInfo && offlineDriverInfo.plate) || (offlineRideSummary && offlineRideSummary.plateNumber) || null,
    };
  });
  const [loading, setLoading] = useState(!offlinePending);
  const [loadError, setLoadError] = useState(null);
  const [offlineMode, setOfflineMode] = useState(!!offlinePending);
  const [offlineNotice, setOfflineNotice] = useState(
    offlinePending ? "Confirming your ride automatically once you're connected. Airport WiFi works fine — no SIM data needed." : null
  );
  const flushingRef = useRef(false);
  // Bumped whenever flushPendingScan lands a confirmed ride — lets fetchRide
  // (above) detect and discard an in-flight GET that resolves afterward
  // with now-stale data. See the comment in fetchRide for the exact race.
  const confirmedGenerationRef = useRef(0);
  const [panicSending, setPanicSending] = useState(false);
  const [panicActive, setPanicActive] = useState(false);
  const [listeningSending, setListeningSending] = useState(false);
  const [starsSelected, setStarsSelected] = useState(0);
  const [ratingComment, setRatingComment] = useState("");
  const [submittingRating, setSubmittingRating] = useState(false);
  const [ratingError, setRatingError] = useState(null);
  // "Same driver, same vehicle, unless you say otherwise" — defaults to
  // true to match that framing; only relevant for an arrival pickup, since
  // that's the leg a return drop-off gets linked back to (see
  // CheckoutScreen's bookReturnDropoff / keep_same_driver_for_return).
  const [keepSameDriver, setKeepSameDriver] = useState(true);
  const [flightIssueWalletMinimum, setFlightIssueWalletMinimum] = useState(null);
  const [flightStatus, setFlightStatus] = useState(null);
  const [flightLoading, setFlightLoading] = useState(false);
  const [flightError, setFlightError] = useState(null);
  const pollRef = useRef(null);
  const flightPollRef = useRef(null);

  // Tipping — optional, offered once the trip is completed, alongside the
  // rating above. Riders never tip in cash: wallet debits immediately,
  // card goes through the same Paystack initialize/verify flow as the fare
  // itself (see CheckoutScreen).
  const [tipPercent, setTipPercent] = useState(15);
  const [customTipInput, setCustomTipInput] = useState("");
  const [useCustomTip, setUseCustomTip] = useState(false);
  const [tipPaymentMethod, setTipPaymentMethod] = useState("wallet");
  const [walletBalance, setWalletBalance] = useState(null);
  const [tipStatus, setTipStatus] = useState("idle"); // idle | opening | verifying | success | error
  const [tipMessage, setTipMessage] = useState(null);
  const pendingTipRef = useRef(null);

  // Chauffeur time-overage charge — automatically computed server-side at
  // trip completion (see PATCH /:id/status in the backend) for a single-day
  // Full Day booking that ran longer than the hours selected at booking.
  // Unlike a tip, the amount isn't rider-chosen — ride.overage_naira is
  // whatever the system already computed; this only collects how to pay it.
  // Same wallet-debit-or-fresh-card-charge rails as everything else here.
  const [overagePaymentMethod, setOveragePaymentMethod] = useState("wallet");
  const [overageStatus, setOverageStatus] = useState("idle"); // idle | opening | verifying | success | error
  const [overageMessage, setOverageMessage] = useState(null);
  const pendingOverageRef = useRef(null);

  const fetchRide = useCallback(async () => {
    if (!rideId) return;
    const generationAtStart = confirmedGenerationRef.current;
    try {
      const { ride: data } = await getRideDetails(token, rideId);
      // If flushPendingScan confirmed the offline scan while this GET was
      // in flight, its result is newer and authoritative — applying this
      // request's now-stale response on top would visibly regress the
      // ride's status (e.g. back to "accepted" after it already flipped to
      // "in_progress"), if only for one poll cycle. Skip it; the next tick
      // will fetch fresh data consistent with the confirmed state.
      if (confirmedGenerationRef.current !== generationAtStart) return;
      setRide(data);
      setPanicActive(!!data.panic_triggered_at);
      setLoadError(null);
      cacheActiveRide(data);
      if (["completed", "cancelled"].includes(data.ride_status)) {
        clearCachedActiveRide();
      }
    } catch (e) {
      // While we're deliberately in offline mode (seeded from the QR scan),
      // a network failure here is expected, not an error worth alarming
      // the rider with — the offline banner below already explains what's
      // going on, and flushPendingScan (below) is what actually recovers.
      if (!(isNetworkError(e) && offlineMode)) {
        setLoadError(e.message || "Couldn't load this ride.");
      }
    } finally {
      setLoading(false);
    }
  }, [token, rideId, offlineMode]);

  // Retries a scan that couldn't reach the server earlier (see ScanScreen.js)
  // the moment there's a real chance it'll succeed — called on every poll
  // tick and whenever the app comes back to the foreground, so it recovers
  // on its own the instant the phone finds a signal or WiFi, no rider action
  // needed. Guards against overlapping attempts with flushingRef.
  const flushPendingScan = useCallback(async () => {
    if (flushingRef.current) return;
    const pending = await getPendingScan();
    if (!pending) return;
    flushingRef.current = true;
    try {
      const { ride: confirmedRide } = await scanRideQr(token, pending.scanToken);
      await clearPendingScan();
      confirmedGenerationRef.current += 1;
      setOfflineMode(false);
      setOfflineNotice(null);
      setLoadError(null);
      setRide(confirmedRide);
      cacheActiveRide(confirmedRide);
    } catch (e) {
      if (!isNetworkError(e)) {
        // Server was reachable and definitively rejected this scan (ride no
        // longer valid, wrong driver, etc.) — retrying the same token
        // forever won't help, so stop queuing it and surface why.
        await clearPendingScan();
        setOfflineNotice(e.message || "Couldn't confirm your ride automatically. Please scan your driver's QR code again.");
      }
      // else: still offline — leave it queued, the next tick will retry.
    } finally {
      flushingRef.current = false;
    }
  }, [token]);

  useEffect(() => {
    fetchRide();
    flushPendingScan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchRide]);

  // Poll for updates (driver location, status changes) while the trip is
  // still active — no point polling once it's completed/cancelled. Keyed on
  // ride?.ride_status so this effect re-runs (clearing the old interval)
  // the moment the status actually changes, instead of a single interval
  // whose closure only ever sees the `ride` value from when it was created
  // (which was always null) and so never actually stopped polling. Each
  // tick also retries any queued offline scan (cheap no-op if none queued).
  useEffect(() => {
    if (ride && ["completed", "cancelled"].includes(ride.ride_status)) {
      return;
    }
    pollRef.current = setInterval(() => {
      fetchRide();
      flushPendingScan();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(pollRef.current);
  }, [fetchRide, flushPendingScan, ride?.ride_status]);

  // This ride's actual flight status — the whole point of requiring a
  // flight number for one-way bookings (see RouteScreen). Only fetched
  // once we know the ride's real flight_number, and only for the pickup
  // airport (LOS), same as HomeScreen's manual "Track" preview uses.
  const fetchFlightStatus = useCallback(async () => {
    if (!ride?.flight_number) return;
    setFlightLoading(true);
    try {
      const data = await getFlightStatus(token, ride.flight_number, "LOS");
      setFlightStatus(data);
      setFlightError(null);
    } catch (e) {
      setFlightError(e.message || "Couldn't look up your flight right now.");
    } finally {
      setFlightLoading(false);
    }
  }, [ride?.flight_number]);

  useEffect(() => {
    if (!ride?.flight_number) return;
    fetchFlightStatus();
  }, [ride?.flight_number, fetchFlightStatus]);

  useEffect(() => {
    if (!ride?.flight_number) return;
    if (["completed", "cancelled"].includes(ride?.ride_status)) return;
    flightPollRef.current = setInterval(fetchFlightStatus, FLIGHT_POLL_INTERVAL_MS);
    return () => clearInterval(flightPollRef.current);
  }, [ride?.flight_number, ride?.ride_status, fetchFlightStatus]);

  const shareRide = async () => {
    try {
      const driverPart = ride?.driver_name ? ` with ${ride.driver_name}` : "";
      const destinationPart = ride?.stops?.[ride.stops.length - 1] || "my destination";
      let linkPart = "";
      // Get (or lazily create) a real read-only link the person can actually
      // open — previously this message had no link at all, so whoever it
      // was sent to had no way to see the trip, just this text. Best-effort:
      // if the link fetch fails, still share the descriptive text alone
      // rather than blocking the whole share sheet on it.
      try {
        const shareResult = await getRideShareLink(token, ride.id);
        if (shareResult?.shareUrl) linkPart = ` Track live: ${shareResult.shareUrl}`;
      } catch (e) {
        // ignore — share the text-only message below instead
      }
      await Share.share({
        message: `I'm on a RideArrivo trip${driverPart}, heading to ${destinationPart}. Pickup was ${ride?.pickup_address || "—"}.${linkPart}`,
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

  // One-way — matches ridearrivo.com's design. Triggering panic (above)
  // already activates this server-side too, so this is only needed when
  // someone wants to turn it on independent of a panic alert.
  const activateListening = async () => {
    if (!rideId) return;
    setListeningSending(true);
    try {
      await activateListeningDevice(token, rideId);
      await fetchRide();
    } catch (e) {
      Alert.alert("Couldn't activate", e.message || "Please try again.");
    } finally {
      setListeningSending(false);
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
      await rateRide(token, rideId, starsSelected, ratingComment.trim() || undefined, ride?.booking_type === "one_way" ? keepSameDriver : undefined);
      await fetchRide();
    } catch (e) {
      setRatingError(e.message || "Couldn't submit your rating. Please try again.");
    } finally {
      setSubmittingRating(false);
    }
  };

  // Only worth fetching once there's actually a tip prompt to show — a
  // completed trip, with a driver, that hasn't been tipped yet.
  const canTip = ride?.ride_status === "completed" && !!ride?.driver_id && !(Number(ride?.tip_naira) > 0);
  useEffect(() => {
    if (!canTip) return;
    getWallet(token).then((w) => setWalletBalance(w.balanceNaira)).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canTip, token]);

  // Same wallet-balance fetch, for the overage-charge prompt below — kept as
  // its own effect (rather than folded into canTip's) since a ride could in
  // principle have an overage and no driver-tip situation at the same time.
  const canPayOverage = ride?.ride_status === "completed" && Number(ride?.overage_naira) > 0 && !ride?.overage_payment_method;
  useEffect(() => {
    if (!canPayOverage) return;
    getWallet(token).then((w) => setWalletBalance(w.balanceNaira)).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canPayOverage, token]);

  // Flight cancelled/rescheduled (services/scheduler.js flags ride.flight_issue
  // and refunds the original fare to the wallet) — check whether the rider
  // still meets the $100-equivalent standing minimum before the trip can
  // start again (re-enforced server-side too, in PATCH /:id/status).
  const hasFlightIssue = !!ride?.flight_issue && ride?.payment_status !== "paid";
  useEffect(() => {
    if (!hasFlightIssue) return;
    getWalletMinimum(token).then(setFlightIssueWalletMinimum).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasFlightIssue, token]);

  const tipAmount = useCustomTip
    ? Math.max(0, Math.round(Number(customTipInput) || 0))
    : Math.round((Number(ride?.fare_naira) || 0) * (tipPercent / 100));

  // Same "app comes back to foreground after the Paystack browser closes"
  // signal CheckoutScreen/WalletScreen use — Linking.openURL doesn't give a
  // direct close callback the way expo-web-browser's auth session would.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      if (nextState !== "active") return;
      flushPendingScan();
      if (pendingTipRef.current) {
        const reference = pendingTipRef.current;
        pendingTipRef.current = null;
        verifyAndApplyCardTip(reference);
      }
      if (pendingOverageRef.current) {
        const reference = pendingOverageRef.current;
        pendingOverageRef.current = null;
        verifyAndApplyCardOverage(reference);
      }
    });
    return () => subscription.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tipAmount, flushPendingScan]);

  const verifyAndApplyCardTip = async (reference) => {
    setTipStatus("verifying");
    try {
      const verification = await verifyPayment(reference);
      if (!verification.success) {
        setTipStatus("error");
        setTipMessage(`Tip payment status: ${verification.status}. If you were charged, contact support with reference ${reference}.`);
        return;
      }
      await tipRide(token, rideId, tipAmount, "card", reference);
      await fetchRide();
      setTipStatus("success");
    } catch (e) {
      setTipStatus("error");
      setTipMessage(e.message || "Something went wrong confirming your tip.");
    }
  };

  const verifyAndApplyCardOverage = async (reference) => {
    setOverageStatus("verifying");
    try {
      const verification = await verifyPayment(reference);
      if (!verification.success) {
        setOverageStatus("error");
        setOverageMessage(`Payment status: ${verification.status}. If you were charged, contact support with reference ${reference}.`);
        return;
      }
      await payRideOverage(token, rideId, "card", reference);
      await fetchRide();
      setOverageStatus("success");
    } catch (e) {
      setOverageStatus("error");
      setOverageMessage(e.message || "Something went wrong confirming this payment.");
    }
  };

  const submitOveragePayment = async () => {
    const overageNaira = Number(ride?.overage_naira) || 0;
    if (!(overageNaira > 0)) return;
    setOverageMessage(null);
    if (overagePaymentMethod === "wallet") {
      setOverageStatus("verifying");
      try {
        await payRideOverage(token, rideId, "wallet");
        await fetchRide();
        setOverageStatus("success");
      } catch (e) {
        setOverageStatus("error");
        setOverageMessage(e.message || "Couldn't complete this payment. Please try again.");
      }
      return;
    }
    setOverageStatus("opening");
    try {
      const { authorizationUrl, reference } = await initializePayment(user.email, overageNaira);
      pendingOverageRef.current = reference;
      await Linking.openURL(authorizationUrl);
    } catch (e) {
      setOverageStatus("error");
      setOverageMessage(e.message || "Something went wrong starting this payment.");
    }
  };

  const submitTip = async () => {
    if (!(tipAmount > 0)) {
      setTipMessage("Choose an amount to tip.");
      setTipStatus("error");
      return;
    }
    setTipMessage(null);
    if (tipPaymentMethod === "wallet") {
      setTipStatus("verifying");
      try {
        await tipRide(token, rideId, tipAmount, "wallet");
        await fetchRide();
        setTipStatus("success");
      } catch (e) {
        setTipStatus("error");
        setTipMessage(e.message || "Couldn't complete your tip. Please try again.");
      }
      return;
    }
    setTipStatus("opening");
    try {
      const { authorizationUrl, reference } = await initializePayment(user.email, tipAmount);
      pendingTipRef.current = reference;
      await Linking.openURL(authorizationUrl);
    } catch (e) {
      setTipStatus("error");
      setTipMessage(e.message || "Something went wrong starting the tip payment.");
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
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 0}
      >
      <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
        <LiveMap
          pickup={ride?.pickup_lat != null ? { lat: Number(ride.pickup_lat), lng: Number(ride.pickup_lng) } : null}
          destination={ride?.destination_lat != null ? { lat: Number(ride.destination_lat), lng: Number(ride.destination_lng) } : null}
          driverLocation={ride?.current_lat != null ? { lat: Number(ride.current_lat), lng: Number(ride.current_lng) } : null}
          etaLabel={`🚗 ${statusLabel}`}
          height={220}
        />

        {offlineMode ? (
          <Card tone="dark" style={{ marginTop: spacing.md, borderColor: colors.amber, borderWidth: 1 }}>
            <Text style={styles.cardLabel}>📡 Working offline</Text>
            <Text style={styles.meta}>{offlineNotice}</Text>
          </Card>
        ) : null}

        {loadError ? (
          <Card tone="dark" style={{ marginTop: spacing.md, borderColor: colors.coral, borderWidth: 1 }}>
            <Text style={styles.warningText}>{loadError}</Text>
          </Card>
        ) : null}

        {hasFlightIssue ? (
          <Card tone="dark" style={{ marginTop: spacing.md, borderColor: colors.amber, borderWidth: 1 }}>
            <Text style={styles.cardLabel}>✈️ Flight {ride.flight_issue === "cancelled" ? "cancelled" : "rescheduled"}</Text>
            <Text style={styles.meta}>
              Your flight {ride.flight_number} was {ride.flight_issue}. We've refunded your original fare to your wallet —
              top up to at least{" "}
              {flightIssueWalletMinimum ? formatFare(flightIssueWalletMinimum.minWalletBalanceNaira) : "$100"} to keep this
              ride booked. You'll be charged the fare again at drop-off.
            </Text>
            <View style={{ height: spacing.sm }} />
            <Button label="Top up wallet" variant="ghost" tone="dark" onPress={() => navigation.navigate("Wallet")} />
          </Card>
        ) : null}

        {ride?.flight_number ? (
          <Card tone="dark" style={{ marginTop: spacing.md }}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
              <Text style={styles.cardLabel}>✈️ Flight {ride.flight_number}</Text>
              {flightLoading ? (
                <ActivityIndicator size="small" color={colors.amber} />
              ) : (
                <Pressable onPress={fetchFlightStatus} hitSlop={8}>
                  <Text style={styles.flightRefresh}>Refresh</Text>
                </Pressable>
              )}
            </View>
            {flightStatus ? (
              <>
                <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 4 }}>
                  <Text style={styles.meta}>{flightStatus.airline || "—"}</Text>
                  <Tag
                    label={(flightStatus.status || "unknown").toUpperCase()}
                    tone={flightStatus.status === "landed" ? "teal" : "amber"}
                  />
                </View>
                <Text style={styles.meta}>
                  Estimated landing:{" "}
                  {flightStatus.arrival?.estimated
                    ? new Date(flightStatus.arrival.estimated).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
                    : "—"}
                  {flightStatus.arrival?.terminal ? ` · Terminal ${flightStatus.arrival.terminal}` : ""}
                </Text>
              </>
            ) : flightError ? (
              <Text style={styles.warningText}>{flightError}</Text>
            ) : (
              <Text style={styles.meta}>Looking up your flight…</Text>
            )}
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
                {ride.booking_type === "one_way" ? (
                  <View style={{ marginTop: spacing.sm }}>
                    <Text style={styles.meta}>Keep the same driver &amp; vehicle for your return trip?</Text>
                    <View style={[styles.bookingRow, { marginTop: 6 }]}>
                      <Pressable
                        onPress={() => setKeepSameDriver(true)}
                        style={[styles.bookingChip, keepSameDriver && styles.bookingChipActive]}
                      >
                        <Text style={[styles.bookingChipText, keepSameDriver && styles.bookingChipTextActive]}>Yes, same driver</Text>
                      </Pressable>
                      <Pressable
                        onPress={() => setKeepSameDriver(false)}
                        style={[styles.bookingChip, !keepSameDriver && styles.bookingChipActive]}
                      >
                        <Text style={[styles.bookingChipText, !keepSameDriver && styles.bookingChipTextActive]}>No, don't need to</Text>
                      </Pressable>
                    </View>
                  </View>
                ) : null}
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

        {ride?.ride_status === "completed" && Number(ride?.overage_naira) > 0 ? (
          <Card tone="dark" style={{ marginTop: spacing.md, borderColor: colors.coral, borderWidth: ride.overage_payment_method ? 0 : 1 }}>
            <Text style={styles.cardLabel}>Extra time charge</Text>
            {ride.overage_payment_method ? (
              <Text style={styles.meta}>
                This trip ran longer than the {Number(ride.included_hours_per_day)}h booked, so an extra {formatFare(ride.overage_naira)} was charged. Paid — thanks.
              </Text>
            ) : (
              <>
                <Text style={styles.meta}>
                  This trip ran longer than the {Number(ride.included_hours_per_day)}h you booked, so there's an extra {formatFare(ride.overage_naira)} to settle for the additional time.
                </Text>
                <View style={{ height: spacing.sm }} />
                <View style={styles.bookingRow}>
                  <Pressable
                    onPress={() => setOveragePaymentMethod("wallet")}
                    style={[styles.bookingChip, overagePaymentMethod === "wallet" && styles.bookingChipActive]}
                  >
                    <Text style={[styles.bookingChipText, overagePaymentMethod === "wallet" && styles.bookingChipTextActive]}>
                      Wallet{walletBalance != null ? ` (₦${Number(walletBalance).toLocaleString()})` : ""}
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={() => setOveragePaymentMethod("card")}
                    style={[styles.bookingChip, overagePaymentMethod === "card" && styles.bookingChipActive]}
                  >
                    <Text style={[styles.bookingChipText, overagePaymentMethod === "card" && styles.bookingChipTextActive]}>Card</Text>
                  </Pressable>
                </View>

                {overageMessage ? <Text style={styles.warningText}>{overageMessage}</Text> : null}
                {overageStatus === "success" ? <Text style={[styles.meta, { color: "#8FD9C4" }]}>Paid — thank you.</Text> : null}

                <View style={{ height: spacing.sm }} />
                {overageStatus === "opening" || overageStatus === "verifying" ? (
                  <ActivityIndicator color={colors.amber} />
                ) : overageStatus !== "success" ? (
                  <Button
                    label={`Pay ${formatFare(ride.overage_naira)}`}
                    variant="ghost"
                    tone="dark"
                    onPress={submitOveragePayment}
                  />
                ) : null}
              </>
            )}
          </Card>
        ) : null}

        {ride?.ride_status === "completed" && hasDriver ? (
          <Card tone="dark" style={{ marginTop: spacing.md }}>
            <Text style={styles.cardLabel}>Tip your driver</Text>
            {Number(ride.tip_naira) > 0 ? (
              <Text style={styles.meta}>You tipped {formatFare(ride.tip_naira)}. Thank you!</Text>
            ) : (
              <>
                <Text style={styles.meta}>
                  Entirely optional — 100% of this goes to {ride.driver_name}. Never cash, same as your fare.
                </Text>
                <View style={{ height: spacing.sm }} />
                <View style={styles.bookingRow}>
                  {TIP_PERCENTS.map((p) => (
                    <Pressable
                      key={p}
                      onPress={() => { setUseCustomTip(false); setTipPercent(p); }}
                      style={[styles.bookingChip, !useCustomTip && tipPercent === p && styles.bookingChipActive]}
                    >
                      <Text style={[styles.bookingChipText, !useCustomTip && tipPercent === p && styles.bookingChipTextActive]}>
                        {p}% ({formatFare(Math.round((Number(ride.fare_naira) || 0) * (p / 100)))})
                      </Text>
                    </Pressable>
                  ))}
                  <Pressable
                    onPress={() => setUseCustomTip(true)}
                    style={[styles.bookingChip, useCustomTip && styles.bookingChipActive]}
                  >
                    <Text style={[styles.bookingChipText, useCustomTip && styles.bookingChipTextActive]}>Custom</Text>
                  </Pressable>
                </View>
                {useCustomTip ? (
                  <TextInput
                    style={styles.input}
                    value={customTipInput}
                    onChangeText={setCustomTipInput}
                    placeholder="Amount (₦)"
                    placeholderTextColor={colors.dark.textMuted}
                    keyboardType="number-pad"
                  />
                ) : null}

                <View style={{ height: spacing.sm }} />
                <View style={styles.bookingRow}>
                  <Pressable
                    onPress={() => setTipPaymentMethod("wallet")}
                    style={[styles.bookingChip, tipPaymentMethod === "wallet" && styles.bookingChipActive]}
                  >
                    <Text style={[styles.bookingChipText, tipPaymentMethod === "wallet" && styles.bookingChipTextActive]}>
                      Wallet{walletBalance != null ? ` (₦${Number(walletBalance).toLocaleString()})` : ""}
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={() => setTipPaymentMethod("card")}
                    style={[styles.bookingChip, tipPaymentMethod === "card" && styles.bookingChipActive]}
                  >
                    <Text style={[styles.bookingChipText, tipPaymentMethod === "card" && styles.bookingChipTextActive]}>Card</Text>
                  </Pressable>
                </View>

                {tipMessage ? <Text style={styles.warningText}>{tipMessage}</Text> : null}
                {tipStatus === "success" ? <Text style={[styles.meta, { color: "#8FD9C4" }]}>Tip sent — thank you!</Text> : null}

                <View style={{ height: spacing.sm }} />
                {tipStatus === "opening" || tipStatus === "verifying" ? (
                  <ActivityIndicator color={colors.amber} />
                ) : tipStatus !== "success" ? (
                  <Button
                    label={tipAmount > 0 ? `Send ${formatFare(tipAmount)} tip` : "Send tip"}
                    variant="ghost"
                    tone="dark"
                    onPress={submitTip}
                  />
                ) : null}
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

        {/* One-way, matches ridearrivo.com: once on, stays on for this ride —
            no toggle-off control, by design. Alerting support above turns
            this on automatically too. */}
        <Pressable
          onPress={activateListening}
          disabled={!!ride?.listening_device_activated_at || listeningSending}
          style={({ pressed }) => [
            styles.listeningBtn,
            !!ride?.listening_device_activated_at && styles.listeningBtnActive,
            (pressed || listeningSending) && { opacity: 0.7 },
          ]}
        >
          {listeningSending ? (
            <ActivityIndicator color={colors.dark.text} />
          ) : (
            <Text style={styles.listeningText}>
              {ride?.listening_device_activated_at ? "🎙️ Listening device: on" : "🎙️ Activate listening device"}
            </Text>
          )}
        </Pressable>
      </ScrollView>
      </KeyboardAvoidingView>
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
  flightRefresh: { color: colors.tealBright, fontSize: 11.5, fontWeight: "600" },
  starRow: { flexDirection: "row", gap: 6, marginTop: spacing.sm, marginBottom: spacing.sm },
  starChar: { fontSize: 28, color: colors.amber },
  bookingRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  bookingChip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.dark.surfaceBorder,
  },
  bookingChipActive: { backgroundColor: colors.amber, borderColor: colors.amber },
  bookingChipText: { color: colors.dark.text, fontSize: 12, fontWeight: "600" },
  bookingChipTextActive: { color: colors.ink },
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
  listeningBtn: {
    marginTop: spacing.sm,
    backgroundColor: colors.dark.fieldBg,
    borderRadius: radius.sm + 2,
    paddingVertical: 13,
    alignItems: "center",
  },
  listeningBtnActive: { backgroundColor: "rgba(244,163,0,0.18)" },
  listeningText: { color: colors.dark.text, fontWeight: "700", fontSize: 13 },
});
