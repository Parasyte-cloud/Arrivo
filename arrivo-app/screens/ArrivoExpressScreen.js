import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
  Pressable,
  Alert,
} from "react-native";
import { Button, Tag } from "../components/UI";
import { MapFirst, RouteFields, Segmented, ChipRow, useMyLocation } from "../components/MapFirst";
import { placeOf, swapPlaces, isResolved, routePresets } from "../utils/mapFirst";
import { colors, spacing } from "../theme/tokens";
import { useAuth } from "../context/AuthContext";
import { useCurrency } from "../hooks/useCurrency";
import {
  getInstantStatus,
  getInstantTiers,
  getInstantQuote,
  createInstantRide,
  cancelInstantRequest,
  getActiveInstantRequest,
  isNetworkError,
} from "../services/api";

// One poll every 4s while searching — snappier than Tracking's 10s
// interval (see TrackingScreen.js) because "did a driver just accept" is
// the single most time-sensitive question in the whole ArrivoExpress flow.
const SEARCH_POLL_MS = 4000;

function requestStatusLabel(status, t) {
  if (status === "searching") return t("arrivoExpress.statusSearching");
  if (status === "offering") return t("arrivoExpress.statusOffering");
  if (status === "matched") return t("arrivoExpress.statusMatched");
  return t("arrivoExpress.statusDefault");
}

// ArrivoExpress: on-demand, metered point-to-point rides (Economy / Comfort /
// XL / Premium) — RideArrivo's Uber-style option, separate from the
// scheduled Route/Chauffeur flows and from the manual On-the-Go concierge
// request. See arrivo-backend/routes/instantRides.js for the contract this
// screen talks to. Once a driver is matched, the ride becomes a normal
// RideArrivo `rides` row, so this hands off straight to the existing
// Tracking screen instead of building a second live-tracking experience.
export default function ArrivoExpressScreen({ navigation, route }) {
  const pre = route?.params?.prefill || {};
  const { token } = useAuth();
  const { formatFare } = useCurrency(token);
  const { t } = useTranslation();

  // "loading" -> "unavailable" | "picker" | "quoted" | "searching"
  const [phase, setPhase] = useState("loading");
  const [loadError, setLoadError] = useState(null);

  const [tiers, setTiers] = useState([]);
  const [selectedTier, setSelectedTier] = useState(null);

  const [pickup, setPickup] = useState(pre.pickup?.address || "");
  const [pickupCoords, setPickupCoords] = useState(pre.pickup && pre.pickup.lat != null ? { lat: pre.pickup.lat, lng: pre.pickup.lng } : null);
  const [destination, setDestination] = useState(pre.destination?.address || "");
  const [destCoords, setDestCoords] = useState(pre.destination && pre.destination.lat != null ? { lat: pre.destination.lat, lng: pre.destination.lng } : null);

  const [quote, setQuote] = useState(null);
  const [quoting, setQuoting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState(null);
  const [rideMode, setRideMode] = useState("now");

  const [activeRequest, setActiveRequest] = useState(null);
  const [cancelling, setCancelling] = useState(false);

  const pollRef = useRef(null);

  const clearPoll = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  // Bootstrap: is ArrivoExpress even on, do we already have a request in
  // flight (app restart, screen re-entry), and what tiers can they pick.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const [status, activeResult] = await Promise.all([
          getInstantStatus(token),
          getActiveInstantRequest(token),
        ]);

        if (cancelled) return;

        if (!status.enabled) {
          setPhase("unavailable");
          return;
        }

        const existing = activeResult.request;

        if (existing && existing.status === "matched" && existing.ride_id) {
          // Already matched (e.g. they left and came back) — nothing to
          // show here, the Tracking screen owns this ride from here on.
          navigation.replace("Tracking", { rideId: existing.ride_id });
          return;
        }

        if (existing) {
          setActiveRequest(existing);
          setPhase("searching");
          return;
        }

        const { tiers: list } = await getInstantTiers(token);
        if (cancelled) return;
        setTiers(list || []);
        setSelectedTier((list || [])[0]?.key || null);
        setPhase("picker");
      } catch (e) {
        if (cancelled) return;
        setLoadError(
          isNetworkError(e)
            ? t("arrivoExpress.networkError")
            : e.message || t("arrivoExpress.loadError")
        );
        setPhase("error");
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Poll for a match while a request is out. Stops itself the moment we
  // leave the "searching" phase (matched/cancelled/expired/unmount).
  useEffect(() => {
    if (phase !== "searching") {
      clearPoll();
      return;
    }

    pollRef.current = setInterval(async () => {
      try {
        const { request } = await getActiveInstantRequest(token);

        if (!request) {
          // No longer active anywhere — either it expired (auto-refunded
          // server-side, see instantWallet.expireInstantRequestsWithRefund)
          // or was cancelled from another device. Either way, nothing left
          // to poll for.
          clearPoll();
          setActiveRequest(null);
          setPhase("picker");
          Alert.alert(
            t("arrivoExpress.expiredTitle"),
            t("arrivoExpress.expiredBody")
          );
          return;
        }

        setActiveRequest(request);

        if (request.status === "matched" && request.ride_id) {
          clearPoll();
          navigation.replace("Tracking", { rideId: request.ride_id });
        }
      } catch (e) {
        // A transient network hiccup here shouldn't kill the search —
        // just try again on the next tick.
      }
    }, SEARCH_POLL_MS);

    return clearPoll;
  }, [phase, token, navigation, clearPoll]);

  const buildTrip = () => ({
    tier: selectedTier,
    pickupAddress: pickup.trim(),
    pickupLat: pickupCoords?.lat,
    pickupLng: pickupCoords?.lng,
    destinationAddress: destination.trim(),
    destinationLat: destCoords?.lat,
    destinationLng: destCoords?.lng,
  });

  const getFare = async () => {
    setError(null);

    if (!selectedTier) {
      setError(t("arrivoExpress.chooseVehicleError"));
      return;
    }
    if (!pickup.trim() || !pickupCoords) {
      setError(t("arrivoExpress.selectPickupError"));
      return;
    }
    if (!destination.trim() || !destCoords) {
      setError(t("arrivoExpress.selectDestinationError"));
      return;
    }

    setQuoting(true);
    try {
      const { quote: q } = await getInstantQuote(token, buildTrip());
      setQuote(q);
      setPhase("quoted");
    } catch (e) {
      setError(e.message || t("arrivoExpress.fareError"));
    } finally {
      setQuoting(false);
    }
  };

  const confirmRide = async () => {
    setError(null);
    setConfirming(true);
    try {
      const result = await createInstantRide(token, buildTrip());
      setActiveRequest(result.request);
      setPhase("searching");
    } catch (e) {
      if (e.message && /insufficient/i.test(e.message)) {
        Alert.alert(
          t("arrivoExpress.insufficientWalletTitle"),
          t("arrivoExpress.insufficientWalletBody"),
          [
            { text: t("arrivoExpress.notNow"), style: "cancel" },
            { text: t("arrivoExpress.topUpWallet"), onPress: () => navigation.navigate("Wallet") },
          ]
        );
      } else if (e.message && /already have an active/i.test(e.message)) {
        // Someone double-tapped, or a request already exists from another
        // session — just resume watching it instead of erroring out.
        try {
          const { request } = await getActiveInstantRequest(token);
          if (request) {
            setActiveRequest(request);
            setPhase("searching");
          } else {
            setError(e.message);
          }
        } catch {
          setError(e.message);
        }
      } else {
        setError(e.message || t("arrivoExpress.bookError"));
      }
    } finally {
      setConfirming(false);
    }
  };

  const cancelSearch = async () => {
    if (!activeRequest?.id) return;
    setCancelling(true);
    try {
      await cancelInstantRequest(token, activeRequest.id);
      clearPoll();
      setActiveRequest(null);
      setQuote(null);
      setPhase("picker");
    } catch (e) {
      Alert.alert(t("arrivoExpress.cantCancelTitle"), e.message || t("arrivoExpress.cantCancelBody"));
    } finally {
      setCancelling(false);
    }
  };

  // ---- The sheet over the map, the same as the web: Where to?, the route, Ride now or Schedule, See fare. ----
  const onLocated = useCallback((p) => { setPickup(p.address); setPickupCoords({ lat: p.lat, lng: p.lng }); setQuote(null); }, []);
  const { locate, locating, locationError } = useMyLocation(onLocated);
  const pickupPlace = placeOf(pickup, pickupCoords);
  const destPlace = placeOf(destination, destCoords);
  const goBack = () => (navigation.canGoBack && navigation.canGoBack() ? navigation.goBack() : navigation.navigate("Home"));
  const pts = (pl) => (isResolved(pl) ? { lat: pl.lat, lng: pl.lng } : null);

  const swap = () => {
    const s = swapPlaces(pickupPlace, destPlace);
    setPickup(s.pickup ? s.pickup.address : "");
    setPickupCoords(pts(s.pickup));
    setDestination(s.destination ? s.destination.address : "");
    setDestCoords(pts(s.destination));
  };

  // Schedule is the booked-ahead flow, which is the Route screen. The trip typed so far goes with the rider.
  const changeMode = (m) => {
    if (m === "schedule") navigation.navigate("Route", routePresets(pickupPlace, destPlace));
    else setRideMode("now");
  };

  const shell = (body, extra = {}) => (
    <MapFirst title="ArrivoExpress" subtitle="RideArrivo" onBack={goBack} pickup={pts(pickupPlace)} destination={pts(destPlace)} {...extra}>
      {body}
    </MapFirst>
  );

  if (phase === "loading") {
    return shell(<View style={styles.centerFill}><ActivityIndicator color={colors.amber} /></View>);
  }

  if (phase === "unavailable") {
    return shell(
      <View>
        <Text style={styles.heading}>{t("arrivoExpress.title")}</Text>
        <Text style={styles.meta}>{t("arrivoExpress.unavailableBody")}</Text>
      </View>
    );
  }

  if (phase === "error") {
    return shell(
      <View>
        <Text style={styles.heading}>{t("arrivoExpress.title")}</Text>
        <Text style={styles.errorText}>{loadError}</Text>
        <Button label={t("arrivoExpress.tryAgain")} onPress={() => { setPhase("loading"); setLoadError(null); }} style={{ marginTop: spacing.md }} />
      </View>
    );
  }

  if (phase === "searching") {
    return shell(
      <View style={{ alignItems: "center", paddingVertical: spacing.md }}>
        <ActivityIndicator color={colors.amber} size="large" />
        <Text style={[styles.successTitle, { marginTop: spacing.md }]}>{requestStatusLabel(activeRequest?.status, t)}</Text>
        <Text style={[styles.meta, { textAlign: "center", marginTop: 6 }]}>
          {activeRequest?.pickup_address} → {activeRequest?.destination_address}
        </Text>
        {activeRequest?.estimated_fare_naira ? <Text style={[styles.fareText, { marginTop: spacing.sm }]}>{formatFare(activeRequest.estimated_fare_naira)}</Text> : null}
        {cancelling ? (
          <ActivityIndicator color={colors.amber} style={{ marginTop: spacing.lg }} />
        ) : (
          <Button label={t("arrivoExpress.cancelRequest")} variant="ghost" tone="dark" style={{ marginTop: spacing.lg, alignSelf: "stretch" }} onPress={cancelSearch} />
        )}
      </View>,
      { pickup: activeRequest?.pickup_lat != null ? { lat: Number(activeRequest.pickup_lat), lng: Number(activeRequest.pickup_lng) } : pts(pickupPlace),
        destination: activeRequest?.destination_lat != null ? { lat: Number(activeRequest.destination_lat), lng: Number(activeRequest.destination_lng) } : pts(destPlace) }
    );
  }

  if (phase === "quoted" && quote) {
    const tierConfig = tiers.find((tr) => tr.key === selectedTier);
    return shell(
      <View>
        <Text style={styles.heading}>{t("arrivoExpress.confirmTitle")}</Text>
        <View style={styles.rowBetween}>
          <Text style={styles.cardLabel}>{tierConfig?.label || selectedTier}</Text>
          {quote.zone === "yellow" ? <Tag label={t("arrivoExpress.highTrafficArea")} tone="amber" /> : null}
        </View>
        <Text style={styles.meta}>{pickup} → {destination}</Text>
        <View style={[styles.rowBetween, { marginTop: spacing.md }]}>
          <Text style={styles.meta}>{t("arrivoExpress.estimatedDistance")}</Text>
          <Text style={styles.metaStrong}>{t("arrivoExpress.distanceKm", { distance: quote.distanceKm?.toFixed?.(1) })}</Text>
        </View>
        <View style={styles.rowBetween}>
          <Text style={styles.meta}>{t("arrivoExpress.estimatedTime")}</Text>
          <Text style={styles.metaStrong}>{t("arrivoExpress.durationMin", { duration: Math.round(quote.durationMin) })}</Text>
        </View>
        <View style={[styles.rowBetween, { marginTop: spacing.sm }]}>
          <Text style={styles.cardLabel}>{t("arrivoExpress.totalFare")}</Text>
          <Text style={styles.fareText}>{formatFare(quote.fareNaira)}</Text>
        </View>
        <Text style={styles.smallMeta}>{t("arrivoExpress.walletChargeNote")}</Text>
        {error ? <Text style={styles.errorText}>{error}</Text> : null}
        {confirming ? (
          <ActivityIndicator color={colors.amber} style={{ marginTop: spacing.lg }} />
        ) : (
          <>
            <Button label={t("arrivoExpress.confirmFindDriver")} onPress={confirmRide} style={{ marginTop: spacing.lg }} />
            <Button label={t("arrivoExpress.back")} variant="ghost" tone="dark" style={{ marginTop: spacing.sm }} onPress={() => { setQuote(null); setPhase("picker"); }} />
          </>
        )}
      </View>
    );
  }

  // phase === "picker"
  return shell(
    <View>
      <View style={styles.rowBetween}>
        <Text style={styles.heading}>{t("arrivoExpress.whereTo")}</Text>
        <Pressable onPress={() => navigation.navigate("Activity")} hitSlop={8} accessibilityRole="link">
          <Text style={styles.link}>{t("mapSheet.trips")}</Text>
        </Pressable>
      </View>
      <RouteFields
        pickup={pickup}
        destination={destination}
        onPickupText={(v) => { setPickup(v); setPickupCoords(null); }}
        onPickupSelect={(p) => { if (p) { setPickup(p.address); setPickupCoords({ lat: p.lat, lng: p.lng }); } }}
        onDestinationText={(v) => { setDestination(v); setDestCoords(null); }}
        onDestinationSelect={(p) => { if (p) { setDestination(p.address); setDestCoords({ lat: p.lat, lng: p.lng }); } }}
        onSwap={swap}
        onLocate={locate}
        locating={locating}
        pickupLabel={t("mapSheet.pickup")}
        destinationLabel={t("mapSheet.destination")}
        pickupPlaceholder={t("mapSheet.setPickup")}
        destinationPlaceholder={t("arrivoExpress.whereTo")}
      />
      {locationError ? <Text style={styles.errorText}>{locationError}</Text> : null}
      <Segmented options={[{ key: "now", label: t("mapSheet.rideNow") }, { key: "schedule", label: t("mapSheet.schedule") }]} value={rideMode} onChange={changeMode} />
      {tiers.length > 1 ? <ChipRow chips={tiers.map((tr) => ({ key: tr.key, label: tr.label }))} activeKey={selectedTier} onPress={(c) => setSelectedTier(c.key)} /> : null}
      {error ? <Text style={styles.errorText}>{error}</Text> : null}
      {quoting ? (
        <ActivityIndicator color={colors.amber} style={{ marginTop: spacing.lg }} />
      ) : (
        <Button label={t("arrivoExpress.seeFare")} onPress={getFare} style={{ marginTop: spacing.md }} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.dark.bg0 },
  centerFill: { alignItems: "center", justifyContent: "center", paddingVertical: 40 },
  heading: { fontSize: 28, fontWeight: "800", color: colors.dark.text, marginBottom: spacing.sm },
  link: { color: colors.primary, fontSize: 15, fontWeight: "800" },
  meta: { color: colors.dark.textMuted, fontSize: 12.5, lineHeight: 18 },
  smallMeta: { color: colors.dark.textMuted, fontSize: 11, marginTop: spacing.sm },
  metaStrong: { color: colors.dark.text, fontSize: 12.5, fontWeight: "600" },
  cardLabel: { color: colors.dark.text, fontWeight: "600", fontSize: 12, marginBottom: 10 },
  successTitle: { color: colors.dark.text, fontSize: 15, fontWeight: "700" },
  errorText: { color: "#C2362B", fontSize: 11.5, marginTop: 4, marginBottom: 8 },
  rowBetween: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  fareText: { color: colors.amber, fontSize: 20, fontWeight: "700" },
});
