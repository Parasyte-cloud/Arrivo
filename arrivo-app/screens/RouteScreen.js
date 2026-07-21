import React, { useEffect, useMemo, useRef, useState } from "react";
import { View, Text, StyleSheet, ScrollView, TextInput, Pressable, Switch, ActivityIndicator } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Card, Button } from "../components/UI";
import { GradientBackground } from "../components/GradientBackground";
import { LiveMap } from "../components/LiveMap";
import AddressAutocomplete from "../components/AddressAutocomplete";
import { colors, spacing, radius } from "../theme/tokens";
import { useAuth } from "../context/AuthContext";
import { getFareQuote } from "../services/api";
import { useCurrency } from "../hooks/useCurrency";

// Luxury toggle only makes sense on Sedan/SUV — Executive is already the
// premium tier, and this mirrors LUXURY_SURCHARGE_USD in
// arrivo-backend/services/fare.js (the actual source of truth for the
// surcharge amount; these labels are just for display before a quote loads).
const LUXURY_LABEL_USD = { sedan: 60, suv: 100 };

// Areas RideArrivo doesn't currently serve — kept as an instant, purely
// client-side UX check against whatever text is typed (no need to wait on
// a fare quote to tell someone we don't operate somewhere). The real fare
// itself no longer comes from a local lookup table like this one — see
// the quote-fetching effect below, which calls the backend's
// POST /api/rides/quote (real driving distance via Google, real formula
// in arrivo-backend/services/fare.js).
const EXCLUDED_AREAS = [
  { name: "Badagry", keywords: ["badagry"] },
  { name: "Epe", keywords: ["epe"] },
  { name: "Ibeju-Lekki", keywords: ["ibeju-lekki", "ibeju lekki"] },
  { name: "Makoko", keywords: ["makoko"] },
];
function findExcludedArea(address) {
  const a = " " + (address || "").toLowerCase() + " ";
  return EXCLUDED_AREAS.find((area) => area.keywords.some((k) => a.indexOf(k) !== -1)) || null;
}

const MAX_PASSENGERS = { sedan: 3, suv: 6, truck: 6 };
const VEHICLES = [
  { id: "sedan", label: "Standard Sedan" },
  { id: "suv", label: "Premium SUV" },
  { id: "truck", label: "Executive Vehicle" },
];
const BOOKING_TYPES = [
  { id: "one_way", label: "One-way pickup", days: 1 },
  { id: "full_day", label: "Full day", days: 1 },
  { id: "full_week", label: "Full week", days: 7 },
  { id: "full_month", label: "Full month", days: 30 },
];

const QUOTE_DEBOUNCE_MS = 400;

export default function RouteScreen({ navigation, route }) {
  const { token } = useAuth();
  const { formatFare, isNigeria } = useCurrency(token);

  // Empty by default — the rider types their own pickup and destination,
  // matching the website's booking form (no pre-filled locations).
  const [pickup, setPickup] = useState("");
  const [pickupCoords, setPickupCoords] = useState(null); // { lat, lng, placeId } | null — set only when a real suggestion is picked
  const [stops, setStops] = useState([""]);
  const [destinationCoords, setDestinationCoords] = useState(null); // coords for the LAST stop only — fare is priced pickup-to-final-destination
  const [vehicle, setVehicle] = useState("suv");
  const [bookingType, setBookingType] = useState("one_way");
  const [adults, setAdults] = useState("1");
  const [securityEscort, setSecurityEscort] = useState(false);
  const [fleetSize, setFleetSize] = useState(0); // 0 | 2 | 3
  const [luxury, setLuxury] = useState(false); // only meaningful for sedan/suv
  const [flightNumber, setFlightNumber] = useState(route?.params?.flightNumber || "");
  const [emergencyContactName, setEmergencyContactName] = useState("");
  const [emergencyContactPhone, setEmergencyContactPhone] = useState("");

  // The live server-computed quote — this, not any local math, is what
  // actually gets charged (the backend re-verifies it against this same
  // formula when the ride is created).
  const [quote, setQuote] = useState(null); // { fareNaira, distanceKm, durationMin } | null
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState(null);
  const quoteDebounceRef = useRef(null);

  const addStop = () => setStops((s) => [...s, ""]);
  const updateStop = (i, val) => {
    setStops((s) => s.map((v, idx) => (idx === i ? val : v)));
    if (i === stops.length - 1) setDestinationCoords(null); // typing invalidates the resolved destination
  };

  const destination = stops[stops.length - 1] || "";
  const excludedArea = useMemo(() => findExcludedArea(destination) || findExcludedArea(pickup), [destination, pickup]);
  const selectedBooking = BOOKING_TYPES.find((b) => b.id === bookingType);
  const passengerCount = Math.max(1, Number(adults) || 0);
  const maxForVehicle = MAX_PASSENGERS[vehicle];
  const overCapacity = passengerCount > maxForVehicle;
  const needsCoords = bookingType === "one_way";
  const coordsResolved = !needsCoords || (!!pickupCoords && !!destinationCoords);

  // Re-fetch a fare quote whenever anything that affects price changes.
  // Debounced so switching vehicle/add-ons rapidly doesn't fire a request
  // per click, and — for one-way trips — only fires once both addresses
  // have resolved real coordinates (typing alone never triggers billed
  // Distance Matrix calls, only picking a suggestion does).
  useEffect(() => {
    clearTimeout(quoteDebounceRef.current);
    setQuote(null);
    setQuoteError(null);

    if (needsCoords && !coordsResolved) return; // nothing to quote yet
    if (excludedArea || overCapacity) return;

    setQuoteLoading(true);
    quoteDebounceRef.current = setTimeout(async () => {
      try {
        const payload = { bookingType, vehicleType: vehicle, securityEscort, fleetSize, luxury: luxury && vehicle !== "truck" };
        if (needsCoords) {
          payload.pickupLat = pickupCoords.lat;
          payload.pickupLng = pickupCoords.lng;
          payload.destinationLat = destinationCoords.lat;
          payload.destinationLng = destinationCoords.lng;
        }
        const result = await getFareQuote(token, payload);
        setQuote(result);
      } catch (e) {
        setQuoteError(e.message || "Couldn't calculate a fare for this trip. Please try again.");
      } finally {
        setQuoteLoading(false);
      }
    }, QUOTE_DEBOUNCE_MS);
    return () => clearTimeout(quoteDebounceRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookingType, vehicle, securityEscort, fleetSize, luxury, pickupCoords, destinationCoords, excludedArea, overCapacity]);

  const canConfirm =
    !excludedArea && !overCapacity && pickup.trim().length > 0 && destination.trim().length > 0 &&
    coordsResolved && !!quote && !quoteLoading;

  const confirm = () => {
    if (!canConfirm) return;
    navigation.navigate("Checkout", {
      amountNaira: quote.fareNaira,
      distanceKm: quote.distanceKm,
      durationMin: quote.durationMin,
      label: `${VEHICLES.find((v) => v.id === vehicle).label}. ${selectedBooking.label}`,
      pickupAddress: pickup,
      stops,
      flightNumber: flightNumber.trim() || undefined,
      vehicleType: vehicle,
      bookingType: selectedBooking.id,
      durationDays: selectedBooking.days,
      securityEscort,
      fleetSize,
      luxury: luxury && vehicle !== "truck",
      emergencyContactName: emergencyContactName.trim() || undefined,
      emergencyContactPhone: emergencyContactPhone.trim() || undefined,
      pickupLat: pickupCoords?.lat,
      pickupLng: pickupCoords?.lng,
      destinationLat: destinationCoords?.lat,
      destinationLng: destinationCoords?.lng,
    });
  };

  return (
    <View style={styles.screen}>
      <GradientBackground variant="dark" />
      <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingBottom: 40 }}>
        <Text style={styles.title}>Set your route</Text>

        <Card tone="dark" style={{ marginBottom: spacing.md }}>
          <Text style={styles.cardLabel}>Booking type</Text>
          <View style={styles.bookingRow}>
            {BOOKING_TYPES.map((b) => (
              <Pressable
                key={b.id}
                onPress={() => setBookingType(b.id)}
                style={[styles.bookingChip, bookingType === b.id && styles.bookingChipActive]}
              >
                <Text style={[styles.bookingChipText, bookingType === b.id && styles.bookingChipTextActive]}>{b.label}</Text>
              </Pressable>
            ))}
          </View>
        </Card>

        <Card tone="dark" style={{ marginBottom: spacing.md }}>
          <View style={styles.stopRow}>
            <View style={[styles.dot, { backgroundColor: colors.tealBright }]} />
            <AddressAutocomplete
              style={{ flex: 1 }}
              inputStyle={styles.stopInput}
              value={pickup}
              onChangeText={setPickup}
              onSelect={(resolved) => setPickupCoords(resolved)}
              placeholder="Pickup address"
            />
          </View>
          {stops.map((stop, i) => (
            <View key={i} style={styles.stopRow}>
              <View style={styles.thread} />
              <View style={[styles.dot, { backgroundColor: i === stops.length - 1 ? colors.coral : colors.amber }]} />
              {i === stops.length - 1 ? (
                <AddressAutocomplete
                  style={{ flex: 1 }}
                  inputStyle={styles.stopInput}
                  value={stop}
                  onChangeText={(v) => updateStop(i, v)}
                  onSelect={(resolved) => setDestinationCoords(resolved)}
                  placeholder="Destination"
                />
              ) : (
                <TextInput
                  style={styles.stopInput}
                  value={stop}
                  onChangeText={(v) => updateStop(i, v)}
                  placeholder={`Stop ${i + 1}`}
                  placeholderTextColor={colors.dark.textMuted}
                />
              )}
            </View>
          ))}
          <Pressable onPress={addStop} style={styles.addStop}>
            <Ionicons name="add-circle-outline" size={16} color={colors.tealBright} />
            <Text style={styles.addStopText}>Add destination</Text>
          </Pressable>
          {needsCoords && pickup.trim() && destination.trim() && !coordsResolved ? (
            <Text style={styles.hintText}>Select a suggested address for pickup and destination so we can calculate your fare.</Text>
          ) : null}
        </Card>

        <Card tone="dark" style={{ marginBottom: spacing.md }}>
          <Text style={styles.cardLabel}>Flight number (optional)</Text>
          <TextInput
            style={styles.flightInput}
            value={flightNumber}
            onChangeText={(v) => setFlightNumber(v.toUpperCase())}
            placeholder="e.g. BA075"
            placeholderTextColor={colors.dark.textMuted}
            autoCapitalize="characters"
          />
        </Card>

        {excludedArea ? (
          <Card tone="dark" style={{ marginBottom: spacing.md, borderColor: colors.coral, borderWidth: 1 }}>
            <Text style={styles.warningText}>
              We don't currently operate in {excludedArea.name}. Please choose a different pickup or destination.
            </Text>
          </Card>
        ) : null}

        <LiveMap
          pickup={pickupCoords ? { ...pickupCoords, label: "Pickup" } : null}
          destination={destinationCoords ? { ...destinationCoords, label: "Destination" } : null}
          etaLabel={quote ? `ETA ~${Math.round(quote.durationMin)} min` : "ETA —"}
          distanceLabel={quote ? `${stops.length} stop${stops.length > 1 ? "s" : ""} · ${quote.distanceKm.toFixed(1)}km` : undefined}
        />

        <Card tone="dark" style={{ marginTop: spacing.md, marginBottom: spacing.md }}>
          <Text style={styles.cardLabel}>Passengers</Text>
          <View style={styles.stopRow}>
            <Text style={styles.passengerLabel}>Adults</Text>
            <TextInput
              style={styles.passengerInput}
              value={adults}
              onChangeText={setAdults}
              keyboardType="number-pad"
              placeholderTextColor={colors.dark.textMuted}
            />
          </View>
          {overCapacity ? (
            <Text style={styles.warningText}>
              This vehicle fits up to {maxForVehicle}. Choose a larger vehicle or add fleet accompaniment below for bigger groups.
            </Text>
          ) : null}
        </Card>

        <Card tone="dark" style={{ marginBottom: spacing.md }}>
          <Text style={styles.cardLabel}>Choose a vehicle</Text>
          {VEHICLES.map((v) => {
            const tooSmall = passengerCount > MAX_PASSENGERS[v.id];
            return (
              <Pressable
                key={v.id}
                onPress={() => !tooSmall && setVehicle(v.id)}
                style={[styles.vehicleRow, tooSmall && { opacity: 0.4 }]}
                disabled={tooSmall}
              >
                <View>
                  <Text style={[styles.vehicleLabel, vehicle === v.id && { color: colors.amber }]}>
                    {vehicle === v.id ? "● " : "○ "}
                    {v.label}
                  </Text>
                  <Text style={styles.vehicleCapacity}>Fits up to {MAX_PASSENGERS[v.id]} passengers</Text>
                </View>
              </Pressable>
            );
          })}
          {vehicle === "sedan" || vehicle === "suv" ? (
            <View style={[styles.toggleRow, { marginTop: 6 }]}>
              <View style={{ flex: 1 }}>
                <Text style={styles.cardLabel}>Luxury</Text>
                <Text style={styles.addonNote}>
                  Nicer {vehicle === "sedan" ? "Sedan" : "SUV"} for this trip — adds ${LUXURY_LABEL_USD[vehicle]} equivalent
                </Text>
              </View>
              <Switch
                value={luxury}
                onValueChange={setLuxury}
                trackColor={{ false: "rgba(255,255,255,0.18)", true: colors.amber }}
              />
            </View>
          ) : null}
        </Card>

        <Card tone="dark" style={{ marginBottom: spacing.md }}>
          <View style={styles.toggleRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.cardLabel}>Security escort</Text>
              <Text style={styles.addonNote}>Adds a dedicated security vehicle</Text>
            </View>
            <Switch
              value={securityEscort}
              onValueChange={setSecurityEscort}
              trackColor={{ false: "rgba(255,255,255,0.18)", true: colors.amber }}
            />
          </View>
        </Card>

        <Card tone="dark" style={{ marginBottom: spacing.md }}>
          <Text style={styles.cardLabel}>Fleet accompaniment</Text>
          <View style={styles.bookingRow}>
            {[0, 2, 3].map((n) => (
              <Pressable
                key={n}
                onPress={() => setFleetSize(n)}
                style={[styles.bookingChip, fleetSize === n && styles.bookingChipActive]}
              >
                <Text style={[styles.bookingChipText, fleetSize === n && styles.bookingChipTextActive]}>
                  {n === 0 ? "None" : `${n} vehicles`}
                </Text>
              </Pressable>
            ))}
          </View>
        </Card>

        <Card tone="dark" style={{ marginBottom: spacing.md }}>
          <Text style={styles.cardLabel}>Emergency contact (optional)</Text>
          <Text style={styles.addonNote}>Someone we can reach if we can't reach you during this ride.</Text>
          <View style={{ height: 6 }} />
          <TextInput
            style={styles.flightInput}
            value={emergencyContactName}
            onChangeText={setEmergencyContactName}
            placeholder="Contact name"
            placeholderTextColor={colors.dark.textMuted}
          />
          <View style={{ height: 8 }} />
          <TextInput
            style={styles.flightInput}
            value={emergencyContactPhone}
            onChangeText={setEmergencyContactPhone}
            placeholder="Contact phone number"
            placeholderTextColor={colors.dark.textMuted}
            keyboardType="phone-pad"
          />
        </Card>

        {!pickup.trim() || !destination.trim() ? (
          <Text style={styles.warningText}>Enter a pickup address and destination to continue.</Text>
        ) : quoteError ? (
          <Text style={styles.warningText}>{quoteError}</Text>
        ) : null}

        <View style={{ height: spacing.lg }} />
        {quoteLoading ? (
          <View style={{ alignItems: "center", paddingVertical: spacing.md }}>
            <ActivityIndicator color={colors.amber} />
            <Text style={styles.quotingText}>Calculating your fare…</Text>
          </View>
        ) : (
          <Button
            label={quote ? `Confirm · ${formatFare(quote.fareNaira)}${!isNigeria ? ` (₦${quote.fareNaira.toLocaleString()})` : ""}` : "Confirm"}
            disabled={!canConfirm}
            trailingIcon
            onPress={confirm}
          />
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.dark.bg0 },
  title: { fontSize: 18, fontWeight: "700", color: colors.dark.text, marginBottom: spacing.md },
  stopRow: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 4 },
  dot: { width: 9, height: 9, borderRadius: 4.5 },
  thread: { width: 2, height: 16, backgroundColor: "rgba(255,255,255,0.25)", marginLeft: 3.5 },
  stopInput: { color: colors.dark.text, fontSize: 13, paddingVertical: 6 },
  addStop: { flexDirection: "row", alignItems: "center", gap: 6, marginLeft: 18, marginTop: 4 },
  addStopText: { color: colors.tealBright, fontSize: 12, fontWeight: "600" },
  hintText: { color: colors.amber, fontSize: 11, marginTop: 8, marginLeft: 18, lineHeight: 15 },
  cardLabel: { color: colors.dark.text, fontWeight: "600", fontSize: 12, marginBottom: 8 },
  flightInput: {
    backgroundColor: colors.dark.fieldBg,
    color: colors.dark.text,
    borderRadius: 10,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    fontSize: 13,
  },
  bookingRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  bookingChip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.dark.surfaceBorder,
  },
  bookingChipActive: { backgroundColor: colors.amber, borderColor: colors.amber },
  bookingChipText: { color: colors.dark.text, fontSize: 12, fontWeight: "600" },
  bookingChipTextActive: { color: colors.ink },
  vehicleRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 9,
    borderBottomWidth: 1,
    borderBottomColor: colors.dark.hairline,
  },
  vehicleLabel: { color: colors.dark.text, fontSize: 13 },
  vehicleCapacity: { color: colors.dark.textMuted, fontSize: 10.5, marginTop: 2, marginLeft: 14 },
  passengerLabel: { color: colors.dark.text, fontSize: 13, flex: 1 },
  passengerInput: {
    color: colors.dark.text, fontSize: 14, fontWeight: "700", width: 60, textAlign: "center",
    backgroundColor: colors.dark.fieldBg, borderRadius: 8, paddingVertical: 6,
  },
  toggleRow: { flexDirection: "row", alignItems: "center" },
  addonNote: { color: colors.dark.textMuted, fontSize: 11, marginTop: 2 },
  warningText: { color: "#FF9B8A", fontSize: 11.5, marginTop: 6, lineHeight: 16 },
  quotingText: { color: colors.dark.textMuted, fontSize: 12, marginTop: 6 },
});
