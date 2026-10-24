import React, { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { Button, Card, IconBadge, Tag } from "../components/UI";
import { colors, radius, spacing } from "../theme/tokens";
import { getFlightStatus } from "../services/api";
import { REQUEST_TIERS } from "./requestTiers";
import { getTier } from "./registry";

// What each tier shows on Home once it is selected. Every panel is one idea
// and one main button. The booking screens behind the buttons are the tier's
// own, so a tier can change inside without the shell noticing.

function PanelHeader({ tierId }) {
  const tier = getTier(tierId);
  return (
    <View style={styles.header}>
      <IconBadge tone="amber" size={40}>
        <Ionicons name={tier.icon} size={20} color={colors.ink} />
      </IconBadge>
      <View style={{ flex: 1 }}>
        <Text style={styles.title}>{tier.label}</Text>
        <Text style={styles.tagline}>{tier.tagline}</Text>
      </View>
    </View>
  );
}

// RideArrivo: airport pickup and drop-off. Keeps the flight tracker because
// pickups are timed off the flight.
function RidePanel({ navigation, token }) {
  const { t } = useTranslation();
  const [flightNumber, setFlightNumber] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [flight, setFlight] = useState(null);

  const trackFlight = async () => {
    if (!flightNumber.trim()) return;
    setLoading(true);
    setError(null);
    setFlight(null);
    try {
      setFlight(await getFlightStatus(token, flightNumber.trim().toUpperCase(), "LOS"));
    } catch (e) {
      setError(e.message || t("home.flightNotFound"));
    } finally {
      setLoading(false);
    }
  };

  // Editing the number clears the old result or error straight away.
  const onChange = (text) => {
    setFlightNumber(text);
    setError(null);
    setFlight(null);
  };

  const flightParam = flightNumber.trim() ? { flightNumber: flightNumber.trim().toUpperCase() } : undefined;

  return (
    <View>
      <PanelHeader tierId="ride" />
      <Card tone="dark" style={{ marginBottom: spacing.md }}>
        <Text style={styles.label}>Flight number (optional)</Text>
        <View style={styles.flightRow}>
          <Ionicons name="airplane-outline" size={16} color={colors.dark.textMuted} />
          <TextInput
            style={styles.flightInput}
            placeholder={t("home.flightPlaceholder")}
            placeholderTextColor={colors.dark.textMuted}
            value={flightNumber}
            onChangeText={onChange}
            autoCapitalize="characters"
            onSubmitEditing={trackFlight}
            returnKeyType="search"
            accessibilityLabel="Flight number"
          />
          <Pressable onPress={trackFlight} style={styles.trackBtn} disabled={loading} accessibilityRole="button" accessibilityLabel="Track flight">
            {loading ? <ActivityIndicator size="small" color={colors.ink} /> : <Text style={styles.trackBtnText}>{t("home.track")}</Text>}
          </Pressable>
        </View>
        {error ? <Text style={styles.errorText}>{error}</Text> : null}
        {flight ? (
          <View style={styles.flightResult}>
            <View style={styles.rowBetween}>
              <Text style={styles.flightAirline}>{flight.airline} {"·"} {flight.flightNumber}</Text>
              <Tag label={(flight.status || "unknown").toUpperCase()} tone={flight.status === "landed" ? "teal" : "amber"} />
            </View>
            <Text style={styles.flightMeta}>
              {t("home.landing", { time: flight.arrival?.estimated ? new Date(flight.arrival.estimated).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "--:--" })}
              {flight.arrival?.terminal ? ` · ${t("home.terminal", { terminal: flight.arrival.terminal })}` : ""}
            </Text>
          </View>
        ) : null}
      </Card>

      <Button label={t("home.bookAirportPickup")} onPress={() => navigation.navigate("Route", flightParam)} trailingIcon />
      <View style={{ height: spacing.sm }} />
      <Button label={t("home.bookAirportDropoff")} onPress={() => navigation.navigate("Route", { presetBookingType: "dropoff" })} variant="ghost" tone="dark" trailingIcon />
      <Pressable style={styles.linkRow} onPress={() => navigation.navigate("OnTheGo")} accessibilityRole="button">
        <Ionicons name="flash-outline" size={15} color={colors.tealBright} />
        <Text style={styles.linkText}>Need a car in the next few hours? Try On the Go</Text>
      </Pressable>
    </View>
  );
}

function ExpressPanel({ navigation }) {
  return (
    <View>
      <PanelHeader tierId="express" />
      <Button label="Book a ride now" onPress={() => navigation.navigate("ArrivoExpress")} trailingIcon />
    </View>
  );
}

function ChaufferPanel({ navigation }) {
  return (
    <View>
      <PanelHeader tierId="chauffer" />
      <Button label="Book a chauffer" onPress={() => navigation.navigate("Chauffeur")} trailingIcon />
    </View>
  );
}

// ArrivoAir, ArrivoBoat and ArrivoRemovals share one panel and one form.
function RequestPanel({ tierId, navigation }) {
  const cfg = REQUEST_TIERS[tierId];
  return (
    <View>
      <PanelHeader tierId={tierId} />
      <Card tone="dark" style={{ marginBottom: spacing.md }}>
        {cfg.steps.map((line, i) => (
          <View key={line} style={[styles.stepRow, i > 0 && { marginTop: spacing.sm }]}>
            <View style={styles.stepNum}>
              <Text style={styles.stepNumText}>{i + 1}</Text>
            </View>
            <Text style={styles.stepText}>{line}</Text>
          </View>
        ))}
      </Card>
      <Button label={cfg.cta} onPress={() => navigation.navigate("RequestForm", { tierId })} trailingIcon />
    </View>
  );
}

// tier id -> the panel that tier shows. Adding a tier means adding a line here.
export const PANELS = {
  ride: RidePanel,
  express: ExpressPanel,
  chauffer: ChaufferPanel,
  air: (props) => <RequestPanel tierId="air" {...props} />,
  boat: (props) => <RequestPanel tierId="boat" {...props} />,
  removals: (props) => <RequestPanel tierId="removals" {...props} />,
};

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginBottom: spacing.md },
  title: { color: colors.dark.text, fontSize: 18, fontWeight: "800" },
  tagline: { color: colors.dark.textMuted, fontSize: 12.5, marginTop: 2, lineHeight: 17 },
  label: { color: colors.dark.textMuted, fontSize: 11.5, fontWeight: "600", marginBottom: 6 },
  rowBetween: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  flightRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: colors.dark.fieldBg,
    borderRadius: radius.sm + 2,
    paddingLeft: spacing.md,
    paddingRight: 6,
  },
  flightInput: { flex: 1, color: colors.dark.text, fontSize: 16, paddingVertical: 12 },
  trackBtn: { backgroundColor: colors.amber, borderRadius: radius.sm, paddingHorizontal: 14, paddingVertical: 9, minWidth: 56, alignItems: "center" },
  trackBtnText: { color: colors.ink, fontWeight: "700", fontSize: 12 },
  errorText: { color: "#FF9B8A", fontSize: 11.5, marginTop: 8 },
  flightResult: { marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: colors.dark.hairline },
  flightAirline: { color: colors.dark.text, fontWeight: "700", fontSize: 13 },
  flightMeta: { color: colors.dark.textMuted, fontSize: 11.5, marginTop: 4 },
  linkRow: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, marginTop: spacing.md, minHeight: 44 },
  linkText: { color: colors.tealBright, fontSize: 12.5, fontWeight: "600" },
  stepRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  stepNum: { width: 24, height: 24, borderRadius: 12, backgroundColor: colors.amber, alignItems: "center", justifyContent: "center" },
  stepNumText: { color: colors.ink, fontSize: 12, fontWeight: "800" },
  stepText: { flex: 1, color: colors.dark.text, fontSize: 13.5, lineHeight: 19 },
});
