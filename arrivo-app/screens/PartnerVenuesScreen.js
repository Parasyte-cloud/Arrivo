// Arrivo Express Phase 3 — Grotto x RideArrivo. Clubs/restaurants RideArrivo
// partners with: pick a venue, book a reserved pickup from it ("we close
// 4am, pick me up" is exactly the scheduled Airport Drop-off flow already
// built — see RouteScreen's "dropoff" booking type — just pointed at a
// venue's address instead of the rider's own). The venue gets guests who
// arrive/leave safely and reliably; the rider gets a real perk for using
// Arrivo to get there, shown right on the card below.
import React, { useCallback, useState } from "react";
import { View, Text, StyleSheet, ScrollView, ActivityIndicator, Pressable } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect } from "@react-navigation/native";
import { Card, Button, Tag } from "../components/UI";
import { GradientBackground } from "../components/GradientBackground";
import { colors, spacing, radius } from "../theme/tokens";
import { useAuth } from "../context/AuthContext";
import { getPartnerVenues } from "../services/api";

const CATEGORY_LABELS = { club: "Club", restaurant: "Restaurant", other: "Venue" };
const CATEGORY_ICONS = { club: "musical-notes-outline", restaurant: "restaurant-outline", other: "location-outline" };

export default function PartnerVenuesScreen({ navigation }) {
  const { token } = useAuth();
  const [loading, setLoading] = useState(true);
  const [venues, setVenues] = useState([]);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const { venues } = await getPartnerVenues(token);
      setVenues(venues || []);
      setError(null);
    } catch (e) {
      setError(e.message || "Couldn't load partner venues.");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const reserveFrom = (venue) => {
    navigation.navigate("Route", {
      presetPickupAddress: venue.address,
      presetPickupLat: venue.lat,
      presetPickupLng: venue.lng,
      presetBookingType: "dropoff",
      partnerVenueId: venue.id,
      partnerVenueName: venue.name,
      partnerVenuePerk: venue.perk_description || undefined,
    });
  };

  return (
    <View style={styles.screen}>
      <GradientBackground variant="dark" />
      <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingBottom: 40 }}>
        <Text style={styles.title}>Reserved pickups</Text>
        <Text style={styles.subtitle}>
          Book ahead from a partner club or restaurant — tell us when you're leaving, and a driver will be there.
        </Text>

        {loading ? (
          <ActivityIndicator color={colors.amber} style={{ marginTop: spacing.xl }} />
        ) : error ? (
          <Card tone="dark" style={{ marginTop: spacing.md }}>
            <Text style={styles.errorText}>{error}</Text>
          </Card>
        ) : venues.length === 0 ? (
          <Card tone="dark" style={{ marginTop: spacing.md }}>
            <Text style={styles.emptyText}>No partner venues yet — check back soon.</Text>
          </Card>
        ) : (
          venues.map((venue) => (
            <Card key={venue.id} tone="dark" style={{ marginTop: spacing.md }}>
              <View style={styles.venueHeader}>
                <View style={styles.venueIconWrap}>
                  <Ionicons name={CATEGORY_ICONS[venue.category] || "location-outline"} size={20} color={colors.amber} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.venueName}>{venue.name}</Text>
                  <Tag label={CATEGORY_LABELS[venue.category] || "Venue"} tone="teal" />
                </View>
              </View>
              <Text style={styles.venueAddress}>{venue.address}</Text>
              {venue.perk_description ? (
                <Text style={styles.venuePerk}>🍸 {venue.perk_description}</Text>
              ) : null}
              <Button
                label={`Reserve a pickup from ${venue.name}`}
                onPress={() => reserveFrom(venue)}
                style={{ marginTop: spacing.md }}
                trailingIcon
              />
            </Card>
          ))
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.dark.bg0 },
  title: { color: colors.dark.text, fontSize: 24, fontWeight: "700", marginBottom: spacing.xs },
  subtitle: { color: colors.dark.textMuted, fontSize: 13.5, lineHeight: 19, marginBottom: spacing.sm },
  venueHeader: { flexDirection: "row", alignItems: "center", marginBottom: spacing.sm },
  venueIconWrap: {
    width: 40, height: 40, borderRadius: radius.md, backgroundColor: "rgba(217,168,108,0.15)",
    alignItems: "center", justifyContent: "center", marginRight: spacing.sm,
  },
  venueName: { color: colors.dark.text, fontSize: 16.5, fontWeight: "700", marginBottom: 4 },
  venueAddress: { color: colors.dark.textMuted, fontSize: 13, lineHeight: 18 },
  venuePerk: { color: "#8FD9C4", fontSize: 13, fontWeight: "600", marginTop: spacing.sm },
  errorText: { color: colors.coral, fontSize: 14 },
  emptyText: { color: colors.dark.textMuted, fontSize: 14 },
});
