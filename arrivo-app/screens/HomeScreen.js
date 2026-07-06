import React, { useState } from "react";
import { View, Text, StyleSheet, ScrollView, Pressable, TextInput, ActivityIndicator } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { Card, Button, Tag } from "../components/UI";
import { colors, spacing, radius } from "../theme/tokens";
import { getFlightStatus } from "../services/api";
import { useAuth } from "../context/AuthContext";

export default function HomeScreen({ navigation }) {
  const { t } = useTranslation();
  const { user } = useAuth();
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
      const data = await getFlightStatus(flightNumber.trim().toUpperCase(), "LOS");
      setFlight(data);
    } catch (e) {
      setError(e.message || t("home.flightNotFound"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingBottom: 40 }}>
        <View style={styles.header}>
          <View>
            <Text style={styles.greet}>{t("home.greeting", { name: user?.name?.split(" ")[0] || "there" })}</Text>
            <Text style={styles.sub}>{t("home.whereTo")}</Text>
          </View>
          <View style={styles.pill}>
            <Text style={styles.pillText}>MMIA · 6:40pm</Text>
          </View>
        </View>

        <Card style={{ marginBottom: spacing.md }}>
          <View style={styles.row}>
            <View style={[styles.dot, { backgroundColor: colors.teal }]} />
            <Text style={styles.cardTitle}>{t("home.airportPickup")}</Text>
          </View>
          <View style={{ height: spacing.sm }} />

          <View style={styles.flightRow}>
            <Ionicons name="airplane-outline" size={16} color={colors.textMuted} />
            <TextInput
              style={styles.flightInput}
              placeholder={t("home.flightPlaceholder")}
              placeholderTextColor={colors.textMuted}
              value={flightNumber}
              onChangeText={setFlightNumber}
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
          <Pressable style={[styles.tile]} onPress={() => navigation.navigate("Route")}>
            <Ionicons name="car-sport-outline" size={22} color={colors.cream} />
            <Text style={styles.tileText}>{t("home.bookRide")}</Text>
          </Pressable>
          <Pressable style={[styles.tile]} onPress={() => navigation.navigate("Chauffeur")}>
            <Ionicons name="person-outline" size={22} color={colors.cream} />
            <Text style={styles.tileText}>{t("home.chauffeurForDay")}</Text>
          </Pressable>
        </View>

        <Card tinted style={{ marginTop: spacing.md }}>
          <View style={styles.rowBetween}>
            <Text style={styles.cardTitle}>{t("home.ownVehicle")}</Text>
            <Tag label={t("home.earnWeekly")} tone="amber" />
          </View>
          <Pressable onPress={() => navigation.navigate("Owner")}>
            <Text style={styles.linkText}>{t("home.listVehicle")}</Text>
          </Pressable>
        </Card>

        <View style={{ height: spacing.lg }} />
        <Button label={t("home.bookAirportPickup")} onPress={() => navigation.navigate("Route")} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.ink },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: spacing.lg },
  greet: { fontSize: 19, fontWeight: "700", color: colors.cream },
  sub: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  pill: { backgroundColor: colors.amber, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 6 },
  pillText: { fontSize: 10, fontWeight: "700", color: colors.ink },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  rowBetween: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  dot: { width: 8, height: 8, borderRadius: 4 },
  cardTitle: { color: colors.cream, fontWeight: "600", fontSize: 13 },
  grid2: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.md },
  tile: {
    flex: 1,
    backgroundColor: colors.card,
    borderColor: colors.cardBorder,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    alignItems: "center",
    gap: 8,
  },
  tileText: { color: colors.cream, fontWeight: "700", fontSize: 12, textAlign: "center" },
  linkText: { color: colors.tealBright, fontSize: 11, fontWeight: "600", marginTop: 8 },
  flightRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: colors.fieldBg,
    borderRadius: radius.sm + 2,
    paddingLeft: spacing.md,
    paddingRight: 6,
  },
  flightInput: { flex: 1, color: colors.cream, fontSize: 13, paddingVertical: 12 },
  trackBtn: {
    backgroundColor: colors.amber,
    borderRadius: radius.sm,
    paddingHorizontal: 14,
    paddingVertical: 9,
    minWidth: 56,
    alignItems: "center",
  },
  trackBtnText: { color: colors.ink, fontWeight: "700", fontSize: 12 },
  errorText: { color: colors.coral, fontSize: 11.5, marginTop: 8 },
  flightResult: {
    marginTop: 10,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: "rgba(255,255,255,0.08)",
  },
  flightAirline: { color: colors.cream, fontWeight: "700", fontSize: 13 },
  flightMeta: { color: colors.textMuted, fontSize: 11.5, marginTop: 4 },
});
