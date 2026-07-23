import React, { useState } from "react";
import { View, Text, StyleSheet, ScrollView, Pressable, TextInput, ActivityIndicator } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { Card, Button, Tag, IconBadge } from "../components/UI";
import { GradientBackground } from "../components/GradientBackground";
import { colors, spacing, radius } from "../theme/tokens";
import { getFlightStatus } from "../services/api";
import { useAuth } from "../context/AuthContext";

export default function HomeScreen({ navigation }) {
  const { t } = useTranslation();
  const { user, token } = useAuth();
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
      const data = await getFlightStatus(token, flightNumber.trim().toUpperCase(), "LOS");
      setFlight(data);
    } catch (e) {
      setError(e.message || t("home.flightNotFound"));
    } finally {
      setLoading(false);
    }
  };

  // Editing the flight number after a failed lookup left the old "No
  // matching flight found" error on screen indefinitely (only Track re-firing
  // the request would clear it) — clear both the stale error and any
  // previously tracked flight result as soon as the rider starts typing a
  // different number, same as every other flight-input field in the app.
  const onFlightNumberChange = (text) => {
    setFlightNumber(text);
    setError(null);
    setFlight(null);
  };

  return (
    <View style={styles.screen}>
      <GradientBackground variant="dark" />
      <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingBottom: 40 }}>
        <View style={styles.header}>
          <View>
            <Text style={styles.greet}>{t("home.greeting", { name: user?.name?.split(" ")[0] || "there" })}</Text>
            <Text style={styles.sub}>{t("home.whereTo")}</Text>
          </View>
          {/* Was a hardcoded "MMIA · 6:40pm" placeholder — always showing the
              same fake airport/time regardless of what the rider actually
              searched, which reads as a real upcoming trip when there isn't
              one. Now only appears once a real flight has been tracked
              below, built from that flight's own arrival airport/ETA. */}
          {flight?.arrival?.estimated ? (
            <View style={styles.pill}>
              <Text style={styles.pillText}>
                {flight.arrival.airport || "MMIA"} ·{" "}
                {new Date(flight.arrival.estimated).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </Text>
            </View>
          ) : null}
        </View>

        <Card tone="dark" style={{ marginBottom: spacing.md }}>
          <View style={styles.row}>
            <IconBadge size={32} tone="dark">
              <Ionicons name="airplane" size={16} color={colors.amber} />
            </IconBadge>
            <Text style={styles.cardTitle}>{t("home.airportPickup")}</Text>
          </View>
          <View style={{ height: spacing.sm }} />

          <View style={styles.flightRow}>
            <Ionicons name="airplane-outline" size={16} color={colors.dark.textMuted} />
            <TextInput
              style={styles.flightInput}
              placeholder={t("home.flightPlaceholder")}
              placeholderTextColor={colors.dark.textMuted}
              value={flightNumber}
              onChangeText={onFlightNumberChange}
              autoCapitalize="characters"
              onSubmitEditing={trackFlight}
              returnKeyType="search"
            />
            <Pressable onPress={trackFlight} style={styles.trackBtn} disabled={loading}>
              {loading ? <ActivityIndicator size="small" color={colors.ink} /> : <Text style={styles.trackBtnText}>{t("home.track")}</Text>}
            </Pressable>
          </View>

          {error ? <Text style={styles.errorText}>{error}</Text> : null}

          {flight ? (
            <View style={styles.flightResult}>
              <View style={styles.rowBetween}>
                <Text style={styles.flightAirline}>{flight.airline} · {flight.flightNumber}</Text>
                <Tag label={(flight.status || "unknown").toUpperCase()} tone={flight.status === "landed" ? "teal" : "amber"} />
              </View>
              <Text style={styles.flightMeta}>
                {t("home.landing", { time: flight.arrival?.estimated ? new Date(flight.arrival.estimated).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—" })}
                {flight.arrival?.terminal ? ` · ${t("home.terminal", { terminal: flight.arrival.terminal })}` : ""}
              </Text>
              <Text style={styles.flightMeta}>{t("home.arrivingAt", { airport: flight.arrival?.airport })}</Text>
            </View>
          ) : null}
        </Card>

        <View style={styles.grid2}>
          <Pressable style={styles.tile} onPress={() => navigation.navigate("Route", flightNumber.trim() ? { flightNumber: flightNumber.trim().toUpperCase() } : undefined)}>
            <IconBadge tone="dark">
              <Ionicons name="car-sport" size={18} color={colors.dark.text} />
            </IconBadge>
            <Text style={styles.tileText}>{t("home.bookRide")}</Text>
          </Pressable>
          <Pressable style={styles.tile} onPress={() => navigation.navigate("Chauffeur")}>
            <IconBadge tone="dark">
              <Ionicons name="person" size={18} color={colors.dark.text} />
            </IconBadge>
            <Text style={styles.tileText}>{t("home.chauffeurForDay")}</Text>
          </Pressable>
        </View>

        <View style={{ height: spacing.lg }} />
        <Button
          label={t("home.bookAirportPickup")}
          onPress={() => navigation.navigate("Route", flightNumber.trim() ? { flightNumber: flightNumber.trim().toUpperCase() } : undefined)}
          trailingIcon
        />
        {/* Airport Drop-off was only reachable indirectly (switching the
            booking-type chip inside "Book a ride") — not obvious it existed
            at all from Home. Same weight as Airport Pickup's CTA above, just
            ghost-styled to keep Pickup as the primary action. */}
        <View style={{ height: spacing.sm }} />
        <Button
          label={t("home.bookAirportDropoff")}
          onPress={() => navigation.navigate("Route", { presetBookingType: "dropoff" })}
          variant="ghost"
          tone="dark"
          trailingIcon
        />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.dark.bg0 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: spacing.lg },
  greet: { fontSize: 19, fontWeight: "700", color: colors.dark.text },
  sub: { fontSize: 12, color: colors.dark.textMuted, marginTop: 2 },
  pill: { backgroundColor: colors.amber, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 6 },
  pillText: { fontSize: 10, fontWeight: "700", color: colors.ink },
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  rowBetween: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  cardTitle: { color: colors.dark.text, fontWeight: "600", fontSize: 13 },
  grid2: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.md },
  tile: {
    flex: 1,
    backgroundColor: colors.dark.surface,
    borderColor: colors.dark.surfaceBorder,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    alignItems: "center",
    gap: 10,
  },
  tileText: { color: colors.dark.text, fontWeight: "700", fontSize: 12, textAlign: "center" },
  linkText: { color: "#9FBBEF", fontSize: 11, fontWeight: "600", marginTop: 8 },
  flightRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: colors.dark.fieldBg,
    borderRadius: radius.sm + 2,
    paddingLeft: spacing.md,
    paddingRight: 6,
  },
  flightInput: { flex: 1, color: colors.dark.text, fontSize: 13, paddingVertical: 12 },
  trackBtn: {
    backgroundColor: colors.amber,
    borderRadius: radius.sm,
    paddingHorizontal: 14,
    paddingVertical: 9,
    minWidth: 56,
    alignItems: "center",
  },
  trackBtnText: { color: colors.ink, fontWeight: "700", fontSize: 12 },
  errorText: { color: "#FF9B8A", fontSize: 11.5, marginTop: 8 },
  flightResult: {
    marginTop: 10,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: colors.dark.hairline,
  },
  flightAirline: { color: colors.dark.text, fontWeight: "700", fontSize: 13 },
  flightMeta: { color: colors.dark.textMuted, fontSize: 11.5, marginTop: 4 },
});
