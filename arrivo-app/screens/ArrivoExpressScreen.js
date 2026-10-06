import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  Pressable,
  Alert,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Card, Button, Tag } from "../components/UI";
import { GradientBackground } from "../components/GradientBackground";
import AddressAutocomplete from "../components/AddressAutocomplete";
import { colors, spacing, radius } from "../theme/tokens";
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

const TIER_ICONS = {
  economy: "car-outline",
  comfort: "car-sport-outline",
  xl: "people-outline",
  premium: "diamond-outline",
};

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
export default function ArrivoExpressScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const { token } = useAuth();
  const { formatFare } = useCurrency(token);
  const { t } = useTranslation();

  // "loading" -> "unavailable" | "picker" | "quoted" | "searching"
  const [phase, setPhase] = useState("loading");
  const [loadError, setLoadError] = useState(null);

  const [tiers, setTiers] = useState([]);
  const [selectedTier, setSelectedTier] = useState(null);

  const [pickup, setPickup] = useState("");
  const [pickupCoords, setPickupCoords] = useState(null);
  const [destination, setDestination] = useState("");
  const [destCoords, setDestCoords] = useState(null);

  const [quote, setQuote] = useState(null);
  const [quoting, setQuoting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState(null);

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

  const insetsStyle = {
    paddingTop: insets.top + spacing.lg,
    paddingHorizontal: spacing.lg,
    paddingBottom: 40,
  };

  if (phase === "loading") {
    return (
      <View style={styles.screen}>
        <GradientBackground variant="dark" />
        <View style={styles.centerFill}>
          <ActivityIndicator color={colors.amber} />
        </View>
      </View>
    );
  }

  if (phase === "unavailable") {
    return (
      <View style={styles.screen}>
        <GradientBackground variant="dark" />
        <ScrollView contentContainerStyle={insetsStyle}>
          <Text style={styles.title}>{t("arrivoExpress.title")}</Text>
          <Card tone="dark" style={{ marginTop: spacing.lg }}>
            <Text style={styles.meta}>{t("arrivoExpress.unavailableBody")}</Text>
          </Card>
        </ScrollView>
      </View>
    );
  }

  if (phase === "error") {
    return (
      <View style={styles.screen}>
        <GradientBackground variant="dark" />
        <ScrollView contentContainerStyle={insetsStyle}>
          <Text style={styles.title}>{t("arrivoExpress.title")}</Text>
          <Card tone="dark" style={{ marginTop: spacing.lg }}>
            <Text style={styles.errorText}>{loadError}</Text>
            <Button
              label={t("arrivoExpress.tryAgain")}
              onPress={() => {
                setPhase("loading");
                setLoadError(null);
              }}
              style={{ marginTop: spacing.md }}
            />
          </Card>
        </ScrollView>
      </View>
    );
  }

  if (phase === "searching") {
    return (
      <View style={styles.screen}>
        <GradientBackground variant="dark" />
        <ScrollView contentContainerStyle={insetsStyle}>
          <Text style={styles.title}>{t("arrivoExpress.title")}</Text>
          <Card tone="dark" style={{ marginTop: spacing.lg, alignItems: "center", paddingVertical: spacing.lg }}>
            <ActivityIndicator color={colors.amber} size="large" />
            <Text style={[styles.successTitle, { marginTop: spacing.md }]}>
              {requestStatusLabel(activeRequest?.status, t)}
            </Text>
            <Text style={[styles.meta, { textAlign: "center", marginTop: 6 }]}>
              {activeRequest?.pickup_address} → {activeRequest?.destination_address}
            </Text>
            {activeRequest?.estimated_fare_naira ? (
              <Text style={[styles.fareText, { marginTop: spacing.sm }]}>
                {formatFare(activeRequest.estimated_fare_naira)}
              </Text>
            ) : null}
          </Card>

          {cancelling ? (
            <ActivityIndicator color={colors.amber} style={{ marginTop: spacing.lg }} />
          ) : (
            <Button
              label={t("arrivoExpress.cancelRequest")}
              variant="ghost"
              tone="dark"
              style={{ marginTop: spacing.lg }}
              onPress={cancelSearch}
            />
          )}
        </ScrollView>
      </View>
    );
  }

  if (phase === "quoted" && quote) {
    const tierConfig = tiers.find((t) => t.key === selectedTier);
    return (
      <View style={styles.screen}>
        <GradientBackground variant="dark" />
        <ScrollView contentContainerStyle={insetsStyle}>
          <Text style={styles.title}>{t("arrivoExpress.confirmTitle")}</Text>

          <Card tone="dark" style={{ marginTop: spacing.lg }}>
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
          </Card>

          {error ? <Text style={styles.errorText}>{error}</Text> : null}

          {confirming ? (
            <ActivityIndicator color={colors.amber} style={{ marginTop: spacing.lg }} />
          ) : (
            <>
              <Button label={t("arrivoExpress.confirmFindDriver")} onPress={confirmRide} style={{ marginTop: spacing.lg }} />
              <Button
                label={t("arrivoExpress.back")}
                variant="ghost"
                tone="dark"
                style={{ marginTop: spacing.sm }}
                onPress={() => {
                  setQuote(null);
                  setPhase("picker");
                }}
              />
            </>
          )}
        </ScrollView>
      </View>
    );
  }

  // phase === "picker"
  return (
    <View style={styles.screen}>
      <GradientBackground variant="dark" />
      <ScrollView contentContainerStyle={insetsStyle} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>{t("arrivoExpress.title")}</Text>
        <Text style={styles.meta}>{t("arrivoExpress.tagline")}</Text>

        <Card tone="dark" style={{ marginTop: spacing.lg }}>
          <Text style={styles.cardLabel}>{t("arrivoExpress.chooseYourRide")}</Text>
          {tiers.map((tier) => {
            const active = tier.key === selectedTier;
            return (
              <Pressable
                key={tier.key}
                style={[styles.tierRow, active && styles.tierRowActive]}
                onPress={() => setSelectedTier(tier.key)}
              >
                <Ionicons
                  name={TIER_ICONS[tier.key] || "car-outline"}
                  size={20}
                  color={active ? colors.amber : colors.dark.text}
                />
                <View style={{ flex: 1, marginLeft: spacing.sm }}>
                  <Text style={styles.tierLabel}>{tier.label}</Text>
                  <Text style={styles.tierDescription}>{tier.description}</Text>
                </View>
                {active ? <Ionicons name="checkmark-circle" size={20} color={colors.amber} /> : null}
              </Pressable>
            );
          })}
        </Card>

        <Card tone="dark" style={{ marginTop: spacing.md }}>
          <Text style={styles.cardLabel}>{t("arrivoExpress.whereTo")}</Text>
          <AddressAutocomplete
            style={{ marginBottom: spacing.sm }}
            value={pickup}
            onChangeText={(text) => {
              setPickup(text);
              setPickupCoords(null);
            }}
            onSelect={({ address, lat, lng }) => {
              setPickup(address);
              setPickupCoords({ lat, lng });
            }}
            placeholder={t("arrivoExpress.pickupPlaceholder")}
          />
          <AddressAutocomplete
            value={destination}
            onChangeText={(text) => {
              setDestination(text);
              setDestCoords(null);
            }}
            onSelect={({ address, lat, lng }) => {
              setDestination(address);
              setDestCoords({ lat, lng });
            }}
            placeholder={t("arrivoExpress.destinationPlaceholder")}
          />
        </Card>

        {error ? <Text style={styles.errorText}>{error}</Text> : null}

        {quoting ? (
          <ActivityIndicator color={colors.amber} style={{ marginTop: spacing.lg }} />
        ) : (
          <Button label={t("arrivoExpress.seeFare")} onPress={getFare} style={{ marginTop: spacing.lg }} />
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.dark.bg0 },
  centerFill: { flex: 1, alignItems: "center", justifyContent: "center" },
  title: { fontSize: 19, fontWeight: "700", color: colors.dark.text, marginBottom: spacing.sm },
  meta: { color: colors.dark.textMuted, fontSize: 12.5, lineHeight: 18 },
  smallMeta: { color: colors.dark.textMuted, fontSize: 11, marginTop: spacing.sm },
  metaStrong: { color: colors.dark.text, fontSize: 12.5, fontWeight: "600" },
  cardLabel: { color: colors.dark.text, fontWeight: "600", fontSize: 12, marginBottom: 10 },
  successTitle: { color: colors.dark.text, fontSize: 15, fontWeight: "700" },
  errorText: { color: "#FF9B8A", fontSize: 11.5, marginTop: 4, marginBottom: 8 },
  rowBetween: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  fareText: { color: colors.amber, fontSize: 20, fontWeight: "700" },
  tierRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.sm + 2,
    marginBottom: 6,
  },
  tierRowActive: {
    backgroundColor: "rgba(244,163,0,0.14)",
  },
  tierLabel: { color: colors.dark.text, fontSize: 13.5, fontWeight: "700" },
  tierDescription: { color: colors.dark.textMuted, fontSize: 11, marginTop: 2 },
});
