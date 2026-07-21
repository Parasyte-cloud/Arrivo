import React, { useEffect, useRef, useState } from "react";
import { View, Text, StyleSheet, ScrollView, TextInput, Pressable, Switch, ActivityIndicator } from "react-native";
import { Card, Button } from "../components/UI";
import { GradientBackground } from "../components/GradientBackground";
import { colors, spacing } from "../theme/tokens";
import { useAuth } from "../context/AuthContext";
import { getFareQuote } from "../services/api";
import { useCurrency } from "../hooks/useCurrency";

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
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [purpose, setPurpose] = useState("");
  const [hours, setHours] = useState("6");
  const [choice, setChoice] = useState("suv");
  const [duration, setDuration] = useState("full_day");
  const [luxury, setLuxury] = useState(false); // only meaningful for sedan/suv

  // "Single day" can now be booked for more than one consecutive full day —
  // mirrors RouteScreen's identical picker + arrivo-backend/services/fare.js's
  // MAX_FULL_DAY_COUNT cap (past 6 days, "Full week" is already cheaper for
  // the same length of time). Irrelevant for full_week/full_month.
  const MAX_FULL_DAY_COUNT = 6;
  const [fullDayCount, setFullDayCount] = useState(1);
  const [fullDayCountInput, setFullDayCountInput] = useState("1");
  const setFullDayCountClamped = (n) => {
    const clamped = Math.min(Math.max(Number.isFinite(n) ? Math.round(n) : 1, 1), MAX_FULL_DAY_COUNT);
    setFullDayCount(clamped);
    setFullDayCountInput(String(clamped));
  };

  const [quote, setQuote] = useState(null); // { fareNaira } | null
  const [quoteLoading, setQuoteLoading] = useState(true);
  const [quoteError, setQuoteError] = useState(null);
  const debounceRef = useRef(null);

  const selectedDuration = DURATIONS.find((d) => d.id === duration);
  const canConfirm = pickupAddress.trim().length > 0 && date.trim().length > 0 && time.trim().length > 0 && !!quote && !quoteLoading;

  useEffect(() => {
    clearTimeout(debounceRef.current);
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
        setQuote(result);
      } catch (e) {
        setQuoteError(e.message || "Couldn't calculate a price for this booking. Please try again.");
      } finally {
        setQuoteLoading(false);
      }
    }, QUOTE_DEBOUNCE_MS);
    return () => clearTimeout(debounceRef.current);
  }, [choice, duration, luxury, fullDayCount, token]);

  const confirm = () => {
    if (!canConfirm) return;
    navigation.navigate("Checkout", {
      amountNaira: quote.fareNaira,
      label: `Chauffeur — ${VEHICLES.find((v) => v.id === choice).label} · ${selectedDuration.label}${duration === "full_day" && fullDayCount > 1 ? ` × ${fullDayCount} days` : ""} · ${date} ${time}${duration === "full_day" ? ` · ${hours}h/day` : ""}${purpose ? ` (${purpose})` : ""}`,
      pickupAddress: pickupAddress.trim(),
      stops: [],
      vehicleType: choice,
      bookingType: duration,
      durationDays: duration === "full_day" ? fullDayCount : selectedDuration.days,
      luxury: luxury && (choice === "sedan" || choice === "suv"),
    });
  };

  return (
    <View style={styles.screen}>
      <GradientBackground variant="dark" />
      <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingBottom: 40 }}>
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
            <View style={{ marginTop: spacing.sm }}>
              <Text style={styles.addonNote}>How many full days? (leave at 1 if it's just the one)</Text>
              <View style={[styles.bookingRow, { marginTop: 6 }]}>
                {[1, 2, 3, 4, 5, 6].map((n) => (
                  <Pressable
                    key={n}
                    onPress={() => setFullDayCountClamped(n)}
                    style={[styles.bookingChip, fullDayCount === n && styles.bookingChipActive]}
                  >
                    <Text style={[styles.bookingChipText, fullDayCount === n && styles.bookingChipTextActive]}>{n} day{n > 1 ? "s" : ""}</Text>
                  </Pressable>
                ))}
              </View>
              <View style={{ flexDirection: "row", alignItems: "center", marginTop: spacing.sm }}>
                <Text style={styles.addonNote}>Or type a number (1–{MAX_FULL_DAY_COUNT}):</Text>
                <TextInput
                  style={[styles.smallInput, { marginLeft: 8, minWidth: 40 }]}
                  value={fullDayCountInput}
                  onChangeText={(text) => setFullDayCountInput(text.replace(/[^0-9]/g, ""))}
                  onEndEditing={() => setFullDayCountClamped(Number(fullDayCountInput))}
                  keyboardType="number-pad"
                  maxLength={2}
                  placeholderTextColor={colors.dark.textMuted}
                />
              </View>
            </View>
          ) : null}
        </Card>

        <Card tone="dark" style={{ marginBottom: spacing.md }}>
          <Text style={styles.cardLabel}>Pickup address</Text>
          <TextInput
            style={styles.input}
            value={pickupAddress}
            onChangeText={setPickupAddress}
            placeholder="Where should your chauffeur meet you?"
            placeholderTextColor={colors.dark.textMuted}
          />
        </Card>

        <Card tone="dark" style={{ marginBottom: spacing.md }}>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>📅 Date</Text>
            <TextInput
              style={styles.smallInput}
              value={date}
              onChangeText={setDate}
              placeholder="e.g. Sat 25 Jul"
              placeholderTextColor={colors.dark.textMuted}
            />
          </View>
          <View style={styles.divider} />
          <View style={styles.row}>
            <Text style={styles.rowLabel}>🕘 Time</Text>
            <TextInput
              style={styles.smallInput}
              value={time}
              onChangeText={setTime}
              placeholder="e.g. 10:00am"
              placeholderTextColor={colors.dark.textMuted}
            />
          </View>
          {duration === "full_day" ? (
            <>
              <View style={styles.divider} />
              <View style={styles.row}>
                <Text style={styles.rowLabel}>⏱ Hours that day</Text>
                <TextInput
                  style={styles.smallInput}
                  value={hours}
                  onChangeText={setHours}
                  keyboardType="number-pad"
                  placeholderTextColor={colors.dark.textMuted}
                />
              </View>
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

        {!canConfirm && pickupAddress.trim() && date.trim() && time.trim() ? (
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
});
