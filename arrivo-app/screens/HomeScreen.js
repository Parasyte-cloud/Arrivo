import React, { useState } from "react";
import { View, Text, StyleSheet, ScrollView, Pressable, TextInput, ActivityIndicator } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { Card, Button, Tag, IconBadge } from "../components/UI";
import { GradientBackground } from "../components/GradientBackground";
import { colors, spacing, radius, tint } from "../theme/tokens";
import { getFlightStatus, getInstantStatus } from "../services/api";
import { useAuth } from "../context/AuthContext";
import ParasyteSignature from "../components/ParasyteSignature";
import useCatalogue from "../hooks/useCatalogue";
import AddressAutocomplete from "../components/AddressAutocomplete";
import { HUB_GROUPS, openHubCard } from "../utils/services";

const HUB_ICON = { express: "flash", transfer: "airplane", schedule: "calendar", campus: "school", removals: "cube", chauffeur: "person", air: "airplane", boat: "boat" };

export default function HomeScreen({ navigation }) {
  const { t } = useTranslation();
  const { user, token } = useAuth();
  const [flightNumber, setFlightNumber] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [flight, setFlight] = useState(null);
  const cards = useCatalogue(token);
  const [group, setGroup] = useState("ride");
  const [showFlight, setShowFlight] = useState(false);
  // Typed once here, carried into whichever service the rider picks.
  const [pickupText, setPickupText] = useState("");
  const [pickup, setPickup] = useState(null);
  const [destText, setDestText] = useState("");
  const [dest, setDest] = useState(null);
  const where = {
    pickup: pickupText.trim() ? { address: pickup?.address || pickupText.trim(), lat: pickup?.lat, lng: pickup?.lng } : null,
    destination: destText.trim() ? { address: dest?.address || destText.trim(), lat: dest?.lat, lng: dest?.lng } : null,
  };

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

        {/* Same three groups as ridearrivo.com. Every rider can use every card; only drivers
            are limited by tier. At most four cards show at once so the screen stays calm. */}
        <Card tone="dark" style={{ marginBottom: spacing.md }}>
          <AddressAutocomplete style={{ marginBottom: spacing.sm }} value={pickupText} onChangeText={setPickupText} onSelect={setPickup} placeholder={t("hub.pickupPlaceholder")} />
          <AddressAutocomplete value={destText} onChangeText={setDestText} onSelect={setDest} placeholder={t("hub.destinationPlaceholder")} />
        </Card>

        <View style={styles.tabs} accessibilityRole="tablist">
          {HUB_GROUPS.map((g) => (
            <Pressable key={g} onPress={() => setGroup(g)} style={[styles.tab, group === g && styles.tabOn]} accessibilityRole="tab" accessibilityState={{ selected: group === g }}>
              <Text style={[styles.tabText, group === g && styles.tabTextOn]}>{t(`hub.tab_${g}`)}</Text>
            </Pressable>
          ))}
        </View>

        {cards.filter((c) => c.group === group).map((c) => (
          <Pressable key={c.id} style={[styles.hubCard, !c.enabled && { opacity: 0.55 }]} disabled={!c.enabled} onPress={() => openHubCard(navigation, c, where)} accessibilityRole="button" accessibilityLabel={t(`hub.${c.id}_t`)}>
            <IconBadge tone="dark" size={40}>
              <Ionicons name={HUB_ICON[c.id] || "ellipse"} size={19} color={colors.amber} />
            </IconBadge>
            <View style={{ flex: 1, marginLeft: spacing.md }}>
              <Text style={styles.hubTitle}>{t(`hub.${c.id}_t`)}</Text>
              <Text style={styles.hubSub}>{t(`hub.${c.id}_s`)}</Text>
            </View>
            {c.enabled ? <Ionicons name="chevron-forward" size={18} color={colors.dark.textMuted} /> : <Tag label={t("hub.comingSoon")} tone="amber" />}
          </Pressable>
        ))}

        {showFlight ? (
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
                {t("home.landing", { time: flight.arrival?.estimated ? new Date(flight.arrival.estimated).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "--:--" })}
                {flight.arrival?.terminal ? ` · ${t("home.terminal", { terminal: flight.arrival.terminal })}` : ""}
              </Text>
              <Text style={styles.flightMeta}>{t("home.arrivingAt", { airport: flight.arrival?.airport })}</Text>
            </View>
          ) : null}
        </Card>

        ) : (
          <Pressable style={styles.onTheGoRow} onPress={() => setShowFlight(true)}>
            <Ionicons name="airplane-outline" size={15} color={colors.tealBright} />
            <Text style={styles.onTheGoText}>{t("hub.trackFlight")}</Text>
          </Pressable>
        )}
        <Pressable style={styles.onTheGoRow} onPress={() => navigation.navigate("OnTheGo")}>
          <Ionicons name="flash-outline" size={15} color={colors.tealBright} />
          <Text style={styles.onTheGoText}>{t("home.travellingInTheNextFew")}</Text>
        </Pressable>
        <ParasyteSignature />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.dark.bg0 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: spacing.lg },
  greet: { fontSize: 19, fontWeight: "700", color: colors.dark.text },
  sub: { fontSize: 12, color: colors.dark.textMuted, marginTop: 2 },
  servicesLabel: { color: colors.dark.textMuted, fontSize: 11.5, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.6 },
  tabs: { flexDirection: "row", backgroundColor: tint(0.06), borderRadius: radius.pill, padding: 4, marginBottom: spacing.md },
  tab: { flex: 1, paddingVertical: 10, borderRadius: radius.pill, alignItems: "center" },
  tabOn: { backgroundColor: colors.fill },
  tabText: { fontWeight: "700", fontSize: 13.5, color: colors.ink },
  tabTextOn: { color: "#FFFFFF" },
  hubCard: { flexDirection: "row", alignItems: "center", backgroundColor: colors.dark.surface, borderColor: colors.dark.surfaceBorder, borderWidth: 1, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.sm },
  hubTitle: { color: colors.dark.text, fontWeight: "700", fontSize: 15 },
  hubSub: { color: colors.dark.textMuted, fontSize: 12.5, marginTop: 2 },
  pill: { backgroundColor: colors.amber, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 6 },
  pillText: { fontSize: 10, fontWeight: "700", color: colors.ink },
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  rowBetween: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  cardTitle: { color: colors.dark.text, fontWeight: "600", fontSize: 13 },
  grid2: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.md },
  arrivoExpressBanner: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.dark.surface,
    borderColor: colors.dark.surfaceBorder,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  arrivoExpressTitle: { color: colors.dark.text, fontWeight: "700", fontSize: 13.5 },
  arrivoExpressSubtitle: { color: colors.dark.textMuted, fontSize: 11, marginTop: 2 },
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
  onTheGoRow: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, marginTop: spacing.md },
  onTheGoText: { color: colors.tealBright, fontSize: 12.5, fontWeight: "600" },
  linkText: { color: "#2E4C8C", fontSize: 11, fontWeight: "600", marginTop: 8 },
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
  errorText: { color: "#C2362B", fontSize: 11.5, marginTop: 8 },
  flightResult: {
    marginTop: 10,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: colors.dark.hairline,
  },
  flightAirline: { color: colors.dark.text, fontWeight: "700", fontSize: 13 },
  flightMeta: { color: colors.dark.textMuted, fontSize: 11.5, marginTop: 4 },
});
