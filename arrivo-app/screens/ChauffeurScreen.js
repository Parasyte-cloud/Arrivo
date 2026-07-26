import React, { useEffect, useRef, useState } from "react";
import { View, Text, StyleSheet, ScrollView, TextInput, Pressable, Switch, ActivityIndicator, KeyboardAvoidingView, Platform, Modal } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Location from "expo-location";
import DateTimePicker from "@react-native-community/datetimepicker";
import { Picker } from "@react-native-picker/picker";
import { Card, Button } from "../components/UI";
import { GradientBackground } from "../components/GradientBackground";
import { colors, spacing } from "../theme/tokens";
import { useAuth } from "../context/AuthContext";
import { getFareQuote, getReverseGeocode } from "../services/api";
import { useCurrency } from "../hooks/useCurrency";

const HOUR_OPTIONS = Array.from({ length: 24 }, (_, i) => i + 1); // 1..24
// Mirrors MAX_FULL_DAY_COUNT in arrivo-backend/services/fare.js — that's a
// sanity ceiling, not a pricing one, so the picker offers the full range
// rather than silently capping something free-typing used to allow.
const DAY_COUNT_OPTIONS = Array.from({ length: 365 }, (_, i) => i + 1); // 1..365

function formatDateDisplay(d) {
  return d ? d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" }) : "";
}
function formatTimeDisplay(d) {
  return d ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
}
// Combines the separately-picked date and time into one real Date object —
// this is what actually gets sent to the backend as scheduledPickupAt.
// Previously date/time here were just free-typed strings dropped into a
// display label and NEVER converted into a real timestamp at all — a
// Chauffeur booking's scheduledPickupAt was silently left undefined the
// entire time, unlike RouteScreen's equivalent scheduled bookings.
function combineDateAndTime(datePart, timePart) {
  if (!datePart || !timePart) return null;
  const combined = new Date(datePart);
  combined.setHours(timePart.getHours(), timePart.getMinutes(), 0, 0);
  return combined;
}

// Mirrors LUXURY_SURCHARGE_USD in arrivo-backend/services/fare.js — only
// Sedan/SUV get the toggle, Executive is already the premium tier.
const LUXURY_LABEL_USD = { sedan: 60, suv: 100 };

// Same vehicle set as RouteScreen (sedan/suv/truck, "truck" labeled
// "Executive Vehicle") rather than this screen's own previous set
// ("Sedan comfort"/"SUV spacious"/"Luxury") — a rider shouldn't see two
// different vehicle-tier vocabularies depending on which booking flow
// they're in. Pricing itself now comes live from the same
// POST /api/rides/quote endpoint RouteScreen uses (see
// arrivo-backend/services/fare.js), instead of a separately maintained
// local price table that had drifted out of sync with the real one.
const VEHICLES = [
  { id: "sedan", label: "Standard Sedan" },
  { id: "suv", label: "Premium SUV" },
  { id: "truck", label: "Executive Vehicle" },
  { id: "pickup", label: "Pickup Truck" },
];
const DURATIONS = [
  { id: "full_day", label: "Single day", days: 1 },
  { id: "full_week", label: "Full week", days: 7 },
  { id: "full_month", label: "Full month", days: 30 },
];

const QUOTE_DEBOUNCE_MS = 400;

export default function ChauffeurScreen({ navigation }) {
  const { token } = useAuth();
  const { formatFare, isNigeria } = useCurrency(token);
  const [pickupAddress, setPickupAddress] = useState("");
  // Same "explicit ask, never on mount" pattern as RouteScreen's identical
  // feature — see the handler below for why.
  const [locatingPickup, setLocatingPickup] = useState(false);
  const [locationError, setLocationError] = useState("");
  const [dateValue, setDateValue] = useState(null); // Date | null — day only, time-of-day ignored
  const [timeValue, setTimeValue] = useState(null); // Date | null — time-of-day only, date part ignored
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showTimePicker, setShowTimePicker] = useState(false);
  const [showHoursPicker, setShowHoursPicker] = useState(false);
  const [purpose, setPurpose] = useState("");
  const [hours, setHours] = useState(6);
  const [choice, setChoice] = useState("suv");
  const [duration, setDuration] = useState("full_day");
  const [luxury, setLuxury] = useState(false); // only meaningful for sedan/suv

  // "Single day" can be booked for any number of consecutive days — the
  // fare is calculated on checkout. Mirrors RouteScreen's identical field;
  // arrivo-backend/services/fare.js still enforces a generous sanity-check
  // upper bound server-side (MAX_FULL_DAY_COUNT there). Irrelevant for
  // full_week/full_month. A picker (see DAY_COUNT_OPTIONS/showDaysPicker)
  // instead of free-typing a number — the only invalid input this used to
  // allow (blank, non-numeric, 0) is no longer possible at all now.
  const [fullDayCount, setFullDayCount] = useState(1);
  const [showDaysPicker, setShowDaysPicker] = useState(false);

  const [quote, setQuote] = useState(null); // { fareNaira } | null
  const [quoteLoading, setQuoteLoading] = useState(true);
  const [quoteError, setQuoteError] = useState(null);
  const debounceRef = useRef(null);
  // Guards against an older in-flight request resolving after a newer one
  // and overwriting a fresh quote/error with a stale result — see the
  // identical guard (and fuller explanation) in RouteScreen.js's quote effect.
  const requestIdRef = useRef(0);

  const selectedDuration = DURATIONS.find((d) => d.id === duration);
  // Backend rejects any scheduledPickupAt in the past (routes/rides.js,
  // "scheduledPickupAt must be in the future") — Chauffeur bookings only
  // started sending this field at all in this same change (see
  // combineDateAndTime below), and both pickers now seed "now" as soon as
  // they're opened, so a rider accepting the defaults without deliberately
  // moving the time forward could previously reach Checkout, get charged by
  // Paystack, and only THEN have ride creation fail on this exact check —
  // mirrors RouteScreen's scheduledTimeValid guard, which blocks earlier.
  const scheduledPickupAtValue = combineDateAndTime(dateValue, timeValue);
  const scheduledTimeValid = !dateValue || !timeValue || scheduledPickupAtValue.getTime() > Date.now();
  const canConfirm =
    pickupAddress.trim().length > 0 && !!dateValue && !!timeValue && scheduledTimeValid && !!quote && !quoteLoading;

  // Same handler as RouteScreen's identical feature: only ever runs on a
  // tap, never on mount, so permission is asked for at the moment it's
  // actually needed. No coordinates to set here (unlike RouteScreen) —
  // chauffeur/day bookings are flat-rate, not distance-priced, so this
  // screen only ever tracked pickupAddress as plain text to begin with.
  const useCurrentLocationForPickup = async () => {
    setLocationError("");
    setLocatingPickup(true);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") {
        setLocationError("Location permission denied — you can still type your pickup address above.");
        return;
      }
      let position;
      try {
        // See RouteScreen.js's identical fix for why this races against a
        // manual timeout — a weak/no GPS signal would otherwise leave this
        // stuck on "Finding your location…" indefinitely with no way out.
        position = await Promise.race([
          Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
          new Promise((_, reject) => setTimeout(() => reject(new Error("Location request timed out")), 12000)),
        ]);
      } catch (e) {
        // GPS itself never produced a fix — most commonly a weak/no signal
        // indoors. Kept as a distinct message from the reverse-geocode
        // failure below (a real coordinate our backend/Google Maps
        // couldn't resolve to an address) so the wording actually points
        // at what went wrong, instead of one generic catch-all hiding
        // which of the two very different failure modes actually happened.
        setLocationError("Couldn't get a GPS signal — try again near a window or outdoors, or type your pickup address above.");
        return;
      }

      try {
        const result = await getReverseGeocode(token, position.coords.latitude, position.coords.longitude);
        setPickupAddress(result.address);
      } catch (e) {
        setLocationError("Got your location, but couldn't look up an address for it — you can still type your pickup address above.");
      }
    } finally {
      setLocatingPickup(false);
    }
  };

  useEffect(() => {
    clearTimeout(debounceRef.current);
    requestIdRef.current += 1;
    const requestId = requestIdRef.current;
    setQuote(null);
    setQuoteLoading(true);
    setQuoteError(null);
    debounceRef.current = setTimeout(async () => {
      try {
        const result = await getFareQuote(token, {
          bookingType: duration,
          vehicleType: choice,
          luxury: luxury && (choice === "sedan" || choice === "suv"),
          durationDays: duration === "full_day" ? fullDayCount : selectedDuration.days,
        });
        if (requestIdRef.current !== requestId) return;
        setQuote(result);
      } catch (e) {
        if (requestIdRef.current !== requestId) return;
        setQuoteError(e.message || "Couldn't calculate a price for this booking. Please try again.");
      } finally {
        if (requestIdRef.current === requestId) setQuoteLoading(false);
      }
    }, QUOTE_DEBOUNCE_MS);
    return () => clearTimeout(debounceRef.current);
  }, [choice, duration, luxury, fullDayCount, token]);

  const confirm = () => {
    if (!canConfirm) return;
    const scheduledPickupAt = scheduledPickupAtValue;
    navigation.navigate("Checkout", {
      amountNaira: quote.fareNaira,
      label: `Chauffeur — ${VEHICLES.find((v) => v.id === choice).label} · ${selectedDuration.label}${duration === "full_day" && fullDayCount > 1 ? ` × ${fullDayCount} days` : ""} · ${formatDateDisplay(dateValue)} ${formatTimeDisplay(timeValue)}${duration === "full_day" ? ` · ${hours}h/day` : ""}${purpose ? ` (${purpose})` : ""}`,
      pickupAddress: pickupAddress.trim(),
      stops: [],
      vehicleType: choice,
      bookingType: duration,
      durationDays: duration === "full_day" ? fullDayCount : selectedDuration.days,
      luxury: luxury && (choice === "sedan" || choice === "suv"),
      // Previously never sent at all — date/time here used to be free-typed
      // display strings only (see combineDateAndTime above), so this was
      // silently undefined for every Chauffeur booking, unlike RouteScreen's
      // equivalent scheduled rides.
      scheduledPickupAt: scheduledPickupAt ? scheduledPickupAt.toISOString() : undefined,
      // Only meaningful for a single-day Full Day booking — the backend
      // only stores this (as included_hours_per_day) for exactly that case,
      // since it's what a possible time-overage charge later gets measured
      // against. Silently omitted for week/month/multi-day bookings, which
      // don't have a comparable per-day hour figure to hold the rider to.
      hoursPerDay: duration === "full_day" && fullDayCount === 1 ? Number(hours) : undefined,
    });
  };

  return (
    <View style={styles.screen}>
      <GradientBackground variant="dark" />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 0}
      >
      <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>Chauffeur</Text>

        <Card tone="dark" style={{ marginBottom: spacing.md }}>
          <Text style={styles.cardLabel}>How long do you need a chauffeur?</Text>
          <View style={styles.bookingRow}>
            {DURATIONS.map((d) => (
              <Pressable
                key={d.id}
                onPress={() => setDuration(d.id)}
                style={[styles.bookingChip, duration === d.id && styles.bookingChipActive]}
              >
                <Text style={[styles.bookingChipText, duration === d.id && styles.bookingChipTextActive]}>{d.label}</Text>
              </Pressable>
            ))}
          </View>
          {duration === "full_day" ? (
            <Pressable style={{ marginTop: spacing.sm }} onPress={() => setShowDaysPicker(true)}>
              <Text style={styles.addonNote}>Number of days</Text>
              <Text style={[styles.smallInput, { marginTop: 6 }]}>
                {fullDayCount} day{fullDayCount === 1 ? "" : "s"}
              </Text>
            </Pressable>
          ) : null}
        </Card>

        <Modal visible={showDaysPicker} animationType="slide" transparent onRequestClose={() => setShowDaysPicker(false)}>
          <Pressable style={styles.pickerOverlay} onPress={() => setShowDaysPicker(false)}>
            <View style={styles.pickerCard} onStartShouldSetResponder={() => true}>
              <View style={styles.pickerHeader}>
                <Text style={styles.pickerTitle}>Number of days</Text>
                <Pressable onPress={() => setShowDaysPicker(false)}>
                  <Text style={styles.pickerDone}>Done</Text>
                </Pressable>
              </View>
              <Picker selectedValue={fullDayCount} onValueChange={setFullDayCount} itemStyle={{ color: colors.dark.text }}>
                {DAY_COUNT_OPTIONS.map((n) => (
                  <Picker.Item key={n} label={`${n} day${n === 1 ? "" : "s"}`} value={n} />
                ))}
              </Picker>
            </View>
          </Pressable>
        </Modal>

        <Card tone="dark" style={{ marginBottom: spacing.md }}>
          <Text style={styles.cardLabel}>Pickup address</Text>
          <TextInput
            style={styles.input}
            value={pickupAddress}
            onChangeText={setPickupAddress}
            placeholder="Where should your chauffeur meet you?"
            placeholderTextColor={colors.dark.textMuted}
          />
          <Pressable onPress={useCurrentLocationForPickup} style={styles.useLocationRow} disabled={locatingPickup}>
            {locatingPickup ? (
              <ActivityIndicator size="small" color={colors.tealBright} />
            ) : (
              <Ionicons name="locate-outline" size={16} color={colors.tealBright} />
            )}
            <Text style={styles.useLocationText}>{locatingPickup ? "Finding your location…" : "Use my current location"}</Text>
          </Pressable>
          {locationError ? <Text style={styles.locationHint}>{locationError}</Text> : null}
        </Card>

        <Card tone="dark" style={{ marginBottom: spacing.md }}>
          <Pressable
            style={styles.row}
            onPress={() => {
              // Seed a real default the instant the picker opens (rather than
              // leaving state null until onChange fires) — iOS's "inline"
              // calendar only fires onChange when you tap a different day,
              // and Android's dialog always returns a value on OK, but this
              // guarantees a value is committed even if someone opens the
              // picker and taps Done/dismiss without touching anything.
              if (!dateValue) setDateValue(new Date());
              setShowDatePicker(true);
            }}
          >
            <Text style={styles.rowLabel}>📅 Date</Text>
            <Text style={[styles.smallInput, !dateValue && { color: colors.dark.textMuted }]}>
              {dateValue ? formatDateDisplay(dateValue) : "Select date"}
            </Text>
          </Pressable>
          <View style={styles.divider} />
          <Pressable
            style={styles.row}
            onPress={() => {
              // Same reasoning as Date above — this is the more important
              // case in practice: iOS's "spinner" time picker only fires
              // onChange when the wheel is physically scrolled to a
              // different value, so tapping Done on the default-displayed
              // time (e.g. "now") without scrolling previously left
              // timeValue stuck at null with no visible error as to why.
              if (!timeValue) setTimeValue(new Date());
              setShowTimePicker(true);
            }}
          >
            <Text style={styles.rowLabel}>🕘 Time</Text>
            <Text style={[styles.smallInput, !timeValue && { color: colors.dark.textMuted }]}>
              {timeValue ? formatTimeDisplay(timeValue) : "Select time"}
            </Text>
          </Pressable>
          {duration === "full_day" ? (
            <>
              <View style={styles.divider} />
              <Pressable style={styles.row} onPress={() => setShowHoursPicker(true)}>
                <Text style={styles.rowLabel}>⏱ Hours that day</Text>
                <Text style={styles.smallInput}>{hours}h</Text>
              </Pressable>
            </>
          ) : null}
          <View style={styles.divider} />
          <View style={styles.row}>
            <Text style={styles.rowLabel}>🎯 Purpose</Text>
            <TextInput
              style={styles.purposeInput}
              value={purpose}
              onChangeText={setPurpose}
              placeholder="e.g. Wedding run"
              placeholderTextColor={colors.dark.textMuted}
            />
          </View>
        </Card>

        {/* Date/time pickers — Android shows its own native dialog the
            instant the component mounts and closes itself on selection
            (see onChange below), so no wrapping Modal is needed there. iOS's
            "inline"/"spinner" displays are persistent embedded views with no
            built-in dismiss, so those get wrapped in the same bottom-sheet
            Modal pattern already used for the language picker elsewhere in
            this app (ProfileScreen/SignupScreen), with an explicit Done button. */}
        {showDatePicker && Platform.OS === "android" ? (
          <DateTimePicker
            value={dateValue || new Date()}
            mode="date"
            display="default"
            minimumDate={new Date()}
            onChange={(event, selected) => {
              setShowDatePicker(false);
              if (event.type === "dismissed") return;
              if (selected) setDateValue(selected);
            }}
          />
        ) : null}
        {showTimePicker && Platform.OS === "android" ? (
          <DateTimePicker
            value={timeValue || new Date()}
            mode="time"
            display="default"
            onChange={(event, selected) => {
              setShowTimePicker(false);
              if (event.type === "dismissed") return;
              if (selected) setTimeValue(selected);
            }}
          />
        ) : null}

        <Modal visible={Platform.OS === "ios" && showDatePicker} animationType="slide" transparent onRequestClose={() => setShowDatePicker(false)}>
          <Pressable style={styles.pickerOverlay} onPress={() => setShowDatePicker(false)}>
            <View style={styles.pickerCard} onStartShouldSetResponder={() => true}>
              <View style={styles.pickerHeader}>
                <Text style={styles.pickerTitle}>Pickup date</Text>
                <Pressable onPress={() => setShowDatePicker(false)}>
                  <Text style={styles.pickerDone}>Done</Text>
                </Pressable>
              </View>
              <DateTimePicker
                value={dateValue || new Date()}
                mode="date"
                display="inline"
                minimumDate={new Date()}
                onChange={(event, selected) => {
                  if (selected) setDateValue(selected);
                }}
              />
            </View>
          </Pressable>
        </Modal>

        <Modal visible={Platform.OS === "ios" && showTimePicker} animationType="slide" transparent onRequestClose={() => setShowTimePicker(false)}>
          <Pressable style={styles.pickerOverlay} onPress={() => setShowTimePicker(false)}>
            <View style={styles.pickerCard} onStartShouldSetResponder={() => true}>
              <View style={styles.pickerHeader}>
                <Text style={styles.pickerTitle}>Pickup time</Text>
                <Pressable onPress={() => setShowTimePicker(false)}>
                  <Text style={styles.pickerDone}>Done</Text>
                </Pressable>
              </View>
              <DateTimePicker
                value={timeValue || new Date()}
                mode="time"
                display="spinner"
                onChange={(event, selected) => {
                  if (selected) setTimeValue(selected);
                }}
              />
            </View>
          </Pressable>
        </Modal>

        {/* Hours-that-day picker — a real scrollable wheel/list instead of
            typing a number. Wrapped in the same bottom-sheet Modal on both
            platforms (rather than leaning on Android's own compact dropdown
            styling) so it looks and behaves identically everywhere. */}
        <Modal visible={showHoursPicker} animationType="slide" transparent onRequestClose={() => setShowHoursPicker(false)}>
          <Pressable style={styles.pickerOverlay} onPress={() => setShowHoursPicker(false)}>
            <View style={styles.pickerCard} onStartShouldSetResponder={() => true}>
              <View style={styles.pickerHeader}>
                <Text style={styles.pickerTitle}>Hours that day</Text>
                <Pressable onPress={() => setShowHoursPicker(false)}>
                  <Text style={styles.pickerDone}>Done</Text>
                </Pressable>
              </View>
              <Picker selectedValue={hours} onValueChange={setHours} itemStyle={{ color: colors.dark.text }}>
                {HOUR_OPTIONS.map((h) => (
                  <Picker.Item key={h} label={`${h} hour${h === 1 ? "" : "s"}`} value={h} />
                ))}
              </Picker>
            </View>
          </Pressable>
        </Modal>

        <Card tone="dark">
          <Text style={styles.cardLabel}>Choose a vehicle</Text>
          {VEHICLES.map((v) => (
            <Pressable key={v.id} onPress={() => setChoice(v.id)} style={styles.optRow}>
              <Text style={[styles.optLabel, choice === v.id && { color: colors.amber }]}>
                {choice === v.id ? "● " : "○ "}
                {v.label}
              </Text>
            </Pressable>
          ))}
          {choice === "sedan" || choice === "suv" ? (
            <View style={[styles.row, { marginTop: 4 }]}>
              <View style={{ flex: 1 }}>
                <Text style={styles.rowLabel}>Luxury</Text>
                <Text style={styles.addonNote}>
                  Nicer {choice === "sedan" ? "Sedan" : "SUV"} — adds ${LUXURY_LABEL_USD[choice]} equivalent
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

        {!canConfirm && pickupAddress.trim() && dateValue && timeValue && !scheduledTimeValid ? (
          <Text style={styles.warningText}>Please choose a pickup time in the future.</Text>
        ) : !canConfirm && pickupAddress.trim() && dateValue && timeValue ? (
          quoteError ? <Text style={styles.warningText}>{quoteError}</Text> : null
        ) : !canConfirm ? (
          <Text style={styles.warningText}>Add a pickup address, date, and time to continue.</Text>
        ) : null}

        <View style={{ height: spacing.lg }} />
        {quoteLoading ? (
          <View style={{ alignItems: "center", paddingVertical: spacing.md }}>
            <ActivityIndicator color={colors.amber} />
            <Text style={styles.quotingText}>Calculating price…</Text>
          </View>
        ) : (
          <Button
            label={quote ? `Continue · ${formatFare(quote.fareNaira)}${!isNigeria ? ` (₦${quote.fareNaira.toLocaleString()})` : ""}` : "Continue"}
            onPress={confirm}
            disabled={!canConfirm}
            trailingIcon
          />
        )}
      </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.dark.bg0 },
  title: { fontSize: 18, fontWeight: "700", color: colors.dark.text, marginBottom: spacing.md },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 8 },
  rowLabel: { color: colors.dark.textMuted, fontSize: 12.5 },
  divider: { height: 1, backgroundColor: colors.dark.hairline },
  smallInput: { color: colors.dark.text, fontSize: 13, textAlign: "right", minWidth: 100 },
  purposeInput: { color: colors.dark.text, fontSize: 13, textAlign: "right", flex: 1, marginLeft: 20 },
  cardLabel: { color: colors.dark.text, fontWeight: "600", fontSize: 12, marginBottom: 8 },
  useLocationRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 8 },
  useLocationText: { color: colors.tealBright, fontSize: 12, fontWeight: "600" },
  locationHint: { color: colors.amber, fontSize: 11, marginTop: 6, lineHeight: 15 },
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
  optRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 9,
    borderBottomWidth: 1,
    borderBottomColor: colors.dark.hairline,
  },
  optLabel: { color: colors.dark.text, fontSize: 13 },
  addonNote: { color: colors.dark.textMuted, fontSize: 11, marginTop: 2 },
  warningText: { color: "#FF9B8A", fontSize: 11.5, marginTop: spacing.sm, textAlign: "center" },
  quotingText: { color: colors.dark.textMuted, fontSize: 12, marginTop: 6 },
  pickerOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "flex-end" },
  pickerCard: { backgroundColor: colors.dark.bg1, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingBottom: 20 },
  pickerHeader: {
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
    padding: 20, paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: colors.dark.hairline,
  },
  pickerTitle: { color: colors.dark.text, fontWeight: "700", fontSize: 15 },
  pickerDone: { color: colors.amber, fontWeight: "700", fontSize: 14 },
});
