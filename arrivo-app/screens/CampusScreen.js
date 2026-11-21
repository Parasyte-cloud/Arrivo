import React, { useCallback, useEffect, useState } from "react";
import { View, Text, StyleSheet, TextInput, ActivityIndicator, Pressable } from "react-native";
import { useTranslation } from "react-i18next";
import { Button } from "../components/UI";
import { MapFirst, RouteFields, Segmented, ChipRow, useMyLocation } from "../components/MapFirst";
import { formatTrip } from "../components/LiveMap";
import PhoneInput from "../components/PhoneInput";
import { colors, spacing, radius } from "../theme/tokens";
import { useAuth } from "../context/AuthContext";
import { splitPhone, validatePhone } from "../utils/phoneValidation";
import { createServiceRequest, getPlacesAutocomplete, getPlaceDetails, getRoute } from "../services/api";
import { messageWithCode } from "../utils/errorRef";
import { placeOf, swapPlaces, isResolved, routePresets, applySchool, flipDirection, firstPrediction, CAMPUS_SCHOOLS } from "../utils/mapFirst";

// ArrivoCampus opens like the web: a full-screen map and a sheet with three steps, Route, Fare, Details.
//   Route    going to school or coming home, pickup and destination, the school gate shortcuts, ride now or schedule.
//   Fare     distance and time from the road, how many friends share the car. The price is confirmed by RideArrivo.
//   Details  phone, notes, the 18+ confirmation, send. It posts the same service request as before.
// The request goes to the drivers who hold the campus service, and RideArrivo confirms the price before the trip starts.
const STEPS = ["route", "fare", "details"];
const MAX_FRIENDS = 6;

export default function CampusScreen({ navigation, route }) {
  const { t } = useTranslation();
  const { token, user } = useAuth();
  const pre = route?.params?.prefill || {};

  const [step, setStep] = useState("route");
  const [direction, setDirection] = useState("to"); // "to" school or "from" school (coming home)
  const [pickup, setPickup] = useState(placeOf(pre.pickup?.address, pre.pickup?.lat != null ? pre.pickup : null));
  const [destination, setDestination] = useState(placeOf(pre.destination?.address, pre.destination?.lat != null ? pre.destination : null));
  const [pickupText, setPickupText] = useState(pre.pickup?.address || "");
  const [destText, setDestText] = useState(pre.destination?.address || "");
  const [schoolKey, setSchoolKey] = useState(null);
  const [busyKey, setBusyKey] = useState(null);
  const [mode, setMode] = useState("now");
  const [when, setWhen] = useState("");
  const [friends, setFriends] = useState(1);
  const [details, setDetails] = useState("");
  const [phone, setPhone] = useState(() => splitPhone(user?.phone || user?.whatsapp_number));
  const [ageOk, setAgeOk] = useState(false);
  const [road, setRoad] = useState(null);
  const [roadLoading, setRoadLoading] = useState(false);
  const [error, setError] = useState(null);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(null);

  const setP = useCallback((p) => { setPickup(p); setPickupText(p ? p.address : ""); }, []);
  const setD = useCallback((p) => { setDestination(p); setDestText(p ? p.address : ""); }, []);
  const onLocated = useCallback((p) => { setP(p); setRoad(null); }, [setP]);
  const { locate, locating, locationError } = useMyLocation(onLocated);

  const goBack = () => (navigation.canGoBack && navigation.canGoBack() ? navigation.goBack() : navigation.navigate("Home"));
  const pts = (p) => (isResolved(p) ? { lat: p.lat, lng: p.lng } : null);

  // The road between the two ends, for the Fare step. A failure is not an error: the numbers are just left out.
  useEffect(() => {
    if (step !== "fare" || !isResolved(pickup) || !isResolved(destination)) return undefined;
    let cancelled = false;
    setRoadLoading(true);
    getRoute(token, pts(pickup), pts(destination))
      .then((r) => { if (!cancelled) setRoad(r && Array.isArray(r.path) && r.path.length > 1 ? r : null); })
      .catch(() => { if (!cancelled) setRoad(null); })
      .finally(() => { if (!cancelled) setRoadLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, pickup, destination, token]);

  // A school shortcut is a search phrase: the first suggestion is looked up and put on the right end for the direction.
  const pickSchool = async (chip) => {
    const school = CAMPUS_SCHOOLS.find((s) => s.key === chip.key);
    if (!school) return;
    setError(null);
    setBusyKey(school.key);
    try {
      const session = Math.random().toString(36).slice(2);
      const { predictions } = await getPlacesAutocomplete(token, school.query, session);
      const hit = firstPrediction(predictions);
      if (!hit) { setError(t("mapSheet.schoolNotFound")); return; }
      const d = await getPlaceDetails(token, hit.placeId, session);
      const place = { address: d.address || hit.description || school.label, lat: d.lat, lng: d.lng };
      const next = applySchool(direction, { pickup, destination }, place);
      setP(next.pickup); setD(next.destination); setSchoolKey(school.key); setRoad(null);
    } catch (e) {
      setError(t("mapSheet.schoolNotFound"));
    } finally {
      setBusyKey(null);
    }
  };

  const changeDirection = (dir) => {
    if (dir === direction) return;
    const f = flipDirection(direction, { pickup, destination });
    setDirection(f.direction); setP(f.pickup); setD(f.destination); setRoad(null);
  };

  const swap = () => { const s = swapPlaces(pickup, destination); setP(s.pickup); setD(s.destination); setRoad(null); };

  const changeMode = (m) => {
    if (m === "schedule") setMode("schedule");
    else setMode("now");
  };

  const toFare = () => {
    setError(null);
    if (!isResolved(pickup)) return setError(t("arrivoExpress.selectPickupError"));
    if (!isResolved(destination)) return setError(t("arrivoExpress.selectDestinationError"));
    setStep("fare");
  };

  const submit = async () => {
    setError(null);
    if (mode === "schedule" && when.trim().length < 3) return setError(t("mapSheet.scheduleNeedsWhen"));
    if (!ageOk) return setError(t("hub.campusConfirm"));
    const ph = validatePhone(phone.dial, phone.national);
    if (!ph.valid) return setError(ph.message);
    setSending(true);
    try {
      const noteParts = [
        mode === "schedule" ? `${t("services.when")}: ${when.trim()}` : null,
        direction === "from" ? t("mapSheet.comingHome") : t("mapSheet.goingToSchool"),
        details.trim() || null,
      ].filter(Boolean);
      const data = await createServiceRequest(token, {
        service: "campus",
        confirmAge18: true,
        pickupAddress: pickup.address,
        destinationAddress: destination.address,
        pickupLat: pickup.lat, pickupLng: pickup.lng,
        destinationLat: destination.lat, destinationLng: destination.lng,
        passengerCount: friends,
        contactPhone: ph.full,
        details: noteParts.join("\n"),
      });
      setSent({ ...data.ride, contact: ph.full });
    } catch (e) {
      setError(messageWithCode(e, t("services.sendFailed")));
    } finally {
      setSending(false);
    }
  };

  const reset = () => { setSent(null); setStep("route"); setP(null); setD(null); setRoad(null); setWhen(""); setDetails(""); setAgeOk(false); setSchoolKey(null); setFriends(1); };

  const tabs = (
    <View style={styles.tabs}>
      {STEPS.map((s) => (
        <View key={s} style={{ flex: 1 }}>
          <View style={[styles.tabBar, STEPS.indexOf(s) <= STEPS.indexOf(step) && styles.tabBarOn]} />
          <Text style={[styles.tabText, s === step && styles.tabTextOn]}>{t(`mapSheet.tab_${s}`)}</Text>
        </View>
      ))}
    </View>
  );

  let body;
  if (sent) {
    body = (
      <View>
        <Text style={styles.heading}>{t("services.sentTitle")}</Text>
        <Text style={styles.meta}>{t("services.sentBody", { service: "ArrivoCampus", id: sent.id, phone: sent.contact })}</Text>
        <Button label={t("services.track")} variant="primary" style={{ marginTop: spacing.md }} onPress={() => navigation.navigate("Tracking", { rideId: sent.id })} />
        <Button label={t("services.another")} variant="ghost" tone="dark" style={{ marginTop: spacing.sm }} onPress={reset} />
      </View>
    );
  } else if (step === "route") {
    body = (
      <View>
        {tabs}
        <Text style={styles.heading}>{t("mapSheet.campusTitle")}</Text>
        <Segmented options={[{ key: "to", label: t("mapSheet.goingToSchool") }, { key: "from", label: t("mapSheet.comingHome") }]} value={direction} onChange={changeDirection} />
        <View style={{ height: spacing.sm }} />
        <RouteFields
          pickup={pickupText}
          destination={destText}
          onPickupText={(v) => { setPickupText(v); setPickup(null); setRoad(null); }}
          onPickupSelect={(p) => { if (p) { setPickup({ address: p.address, lat: p.lat, lng: p.lng }); setPickupText(p.address); } }}
          onDestinationText={(v) => { setDestText(v); setDestination(null); setRoad(null); }}
          onDestinationSelect={(p) => { if (p) { setDestination({ address: p.address, lat: p.lat, lng: p.lng }); setDestText(p.address); } }}
          onSwap={swap}
          onLocate={locate}
          locating={locating}
          pickupLabel={t("mapSheet.pickup")}
          destinationLabel={t("mapSheet.destination")}
          pickupPlaceholder={direction === "from" ? t("mapSheet.whereFrom") : t("mapSheet.whereFrom")}
          destinationPlaceholder={t("arrivoExpress.whereTo")}
        />
        {locationError ? <Text style={styles.errorText}>{locationError}</Text> : null}
        <ChipRow chips={CAMPUS_SCHOOLS.map((s) => ({ key: s.key, label: s.label }))} activeKey={schoolKey} busyKey={busyKey} onPress={pickSchool} />
        <Segmented options={[{ key: "now", label: t("mapSheet.rideNow") }, { key: "schedule", label: t("mapSheet.schedule") }]} value={mode} onChange={changeMode} />
        {mode === "schedule" ? (
          <TextInput style={styles.input} value={when} onChangeText={setWhen} placeholder={t("services.when")} placeholderTextColor={colors.textMuted} maxLength={120} />
        ) : null}
        {error ? <Text style={styles.errorText}>{error}</Text> : null}
        <Button label={t("arrivoExpress.seeFare")} onPress={toFare} style={{ marginTop: spacing.md }} />
      </View>
    );
  } else if (step === "fare") {
    const trip = road ? formatTrip(road.durationSeconds, road.distanceMeters) : "";
    body = (
      <View>
        {tabs}
        <Text style={styles.heading}>{t("mapSheet.tab_fare")}</Text>
        <Text style={styles.meta}>{pickup?.address} → {destination?.address}</Text>
        <View style={[styles.rowBetween, { marginTop: spacing.md }]}>
          <Text style={styles.meta}>{t("arrivoExpress.estimatedDistance")} / {t("arrivoExpress.estimatedTime")}</Text>
          {roadLoading ? <ActivityIndicator size="small" color={colors.amber} /> : <Text style={styles.metaStrong}>{trip || "-"}</Text>}
        </View>
        <View style={[styles.rowBetween, { marginTop: spacing.md }]}>
          <View style={{ flex: 1 }}>
            <Text style={styles.cardLabel}>{t("mapSheet.friends")}</Text>
            <Text style={styles.meta}>{t("mapSheet.friendsBody")}</Text>
          </View>
          <View style={styles.stepper}>
            <Pressable onPress={() => setFriends((n) => Math.max(1, n - 1))} style={styles.stepBtn} accessibilityRole="button" accessibilityLabel="-"><Text style={styles.stepGlyph}>{"−"}</Text></Pressable>
            <Text style={styles.stepValue}>{friends}</Text>
            <Pressable onPress={() => setFriends((n) => Math.min(MAX_FRIENDS, n + 1))} style={styles.stepBtn} accessibilityRole="button" accessibilityLabel="+"><Text style={styles.stepGlyph}>+</Text></Pressable>
          </View>
        </View>
        <Text style={styles.smallMeta}>{t("services.pricePendingLong")}</Text>
        <Button label={t("mapSheet.continue")} onPress={() => { setError(null); setStep("details"); }} style={{ marginTop: spacing.md }} />
        <Button label={t("arrivoExpress.back")} variant="ghost" tone="dark" style={{ marginTop: spacing.sm }} onPress={() => setStep("route")} />
      </View>
    );
  } else {
    body = (
      <View>
        {tabs}
        <Text style={styles.heading}>{t("mapSheet.tab_details")}</Text>
        <TextInput style={styles.input} value={details} onChangeText={setDetails} placeholder={t("services.details")} placeholderTextColor={colors.textMuted} maxLength={900} />
        <PhoneInput tone="dark" dial={phone.dial} national={phone.national} onChangeDial={(dial) => setPhone((p) => ({ ...p, dial }))} onChangeNational={(national) => setPhone((p) => ({ ...p, national }))} />
        <Pressable onPress={() => setAgeOk((v) => !v)} style={styles.confirmRow} accessibilityRole="checkbox" accessibilityState={{ checked: ageOk }}>
          <View style={[styles.box, ageOk && styles.boxOn]}>{ageOk ? <Text style={styles.tick}>✓</Text> : null}</View>
          <Text style={[styles.meta, { flex: 1 }]}>{t("hub.campusConfirm")}</Text>
        </Pressable>
        {error ? <Text style={styles.errorText}>{error}</Text> : null}
        {sending ? <ActivityIndicator color={colors.amber} style={{ marginTop: spacing.sm }} /> : <Button label={t("services.send")} variant="primary" onPress={submit} />}
        <Button label={t("arrivoExpress.back")} variant="ghost" tone="dark" style={{ marginTop: spacing.sm }} onPress={() => setStep("fare")} />
      </View>
    );
  }

  return (
    <MapFirst title="ArrivoCampus" subtitle="RideArrivo" onBack={goBack} pickup={pts(pickup)} destination={pts(destination)}>
      {body}
    </MapFirst>
  );
}

const styles = StyleSheet.create({
  tabs: { flexDirection: "row", gap: 10, marginBottom: spacing.md },
  tabBar: { height: 4, borderRadius: 2, backgroundColor: colors.lineStrong },
  tabBarOn: { backgroundColor: colors.amber },
  tabText: { marginTop: 8, color: colors.textMuted, fontSize: 12, fontWeight: "800", letterSpacing: 1, textTransform: "uppercase" },
  tabTextOn: { color: colors.ink },
  heading: { fontSize: 24, fontWeight: "800", color: colors.ink, marginBottom: spacing.sm },
  meta: { color: colors.textMuted, fontSize: 12.5, lineHeight: 18 },
  smallMeta: { color: colors.textMuted, fontSize: 11, marginTop: spacing.sm },
  metaStrong: { color: colors.ink, fontSize: 13, fontWeight: "700" },
  cardLabel: { color: colors.ink, fontWeight: "700", fontSize: 13, marginBottom: 2 },
  rowBetween: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  errorText: { color: "#C2362B", fontSize: 11.5, marginTop: 6, marginBottom: 6 },
  input: { backgroundColor: colors.fieldBg, color: colors.ink, borderRadius: radius.sm + 2, paddingHorizontal: spacing.md, paddingVertical: 12, fontSize: 14, marginTop: spacing.sm, marginBottom: spacing.sm },
  stepper: { flexDirection: "row", alignItems: "center", gap: 12 },
  stepBtn: { width: 38, height: 38, borderRadius: 19, alignItems: "center", justifyContent: "center", backgroundColor: colors.fieldBg, borderWidth: 1, borderColor: colors.line },
  stepGlyph: { color: colors.ink, fontSize: 20, fontWeight: "700", lineHeight: 22 },
  stepValue: { color: colors.ink, fontSize: 18, fontWeight: "800", minWidth: 18, textAlign: "center" },
  confirmRow: { flexDirection: "row", alignItems: "center", gap: 10, marginVertical: spacing.sm },
  box: { width: 22, height: 22, borderRadius: 6, borderWidth: 1.5, borderColor: colors.textMuted, alignItems: "center", justifyContent: "center" },
  boxOn: { backgroundColor: colors.amber, borderColor: colors.amber },
  tick: { color: colors.ink, fontWeight: "800", fontSize: 14 },
});
