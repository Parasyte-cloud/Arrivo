import React from "react";
import { View, Text, StyleSheet, Pressable, Switch } from "react-native";
import { Card } from "./UI";
import { colors, radius, spacing } from "../theme/tokens";
import {
  securityEscortDescription,
  fleetChipLabel,
  fleetDescription,
  FLEET_SIZES,
} from "../utils/addonPricing";

// The two paid add-ons that sit between the vehicle picker and the emergency
// contact on Plan Route. Pulled out of RouteScreen so the pricing labels can be
// rendered and looked at on their own: the screen imports react-native-maps,
// which will not build outside a native app.
//
// ngnPerUsd comes off the fare quote and may be missing until one lands. The
// escort price falls back to dollars in that case, the fleet prices are already
// in naira and do not need it.

export function AddonOptions({
  securityEscort,
  onSecurityEscortChange,
  fleetSize,
  onFleetSizeChange,
  ngnPerUsd,
  formatFare,
}) {
  return (
    <>
      <Card tone="dark" style={{ marginBottom: spacing.md }}>
        <View style={styles.toggleRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.cardLabel}>Security escort</Text>
            <Text style={styles.addonNote}>
              {securityEscortDescription(ngnPerUsd, formatFare)}
            </Text>
          </View>
          <Switch
            value={securityEscort}
            onValueChange={onSecurityEscortChange}
            trackColor={{ false: "rgba(255,255,255,0.18)", true: colors.amber }}
          />
        </View>
      </Card>

      <Card tone="dark" style={{ marginBottom: spacing.md }}>
        <Text style={styles.cardLabel}>Fleet accompaniment</Text>
        <Text style={styles.addonNote}>{fleetDescription(fleetSize, formatFare)}</Text>
        {/* Prices live on the chips so a rider can compare them without
            having to select one first. The row wraps, since the labels are
            long enough that three will not sit on one line on a phone. */}
        <View style={[styles.bookingRow, { marginTop: 8 }]}>
          {FLEET_SIZES.map((n) => (
            <Pressable
              key={n}
              onPress={() => onFleetSizeChange(n)}
              style={[styles.bookingChip, fleetSize === n && styles.bookingChipActive]}
            >
              <Text style={[styles.bookingChipText, fleetSize === n && styles.bookingChipTextActive]}>
                {fleetChipLabel(n, formatFare)}
              </Text>
            </Pressable>
          ))}
        </View>
      </Card>
    </>
  );
}

// Same values these two cards used while they lived in RouteScreen.
const styles = StyleSheet.create({
  toggleRow: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  cardLabel: { color: colors.dark.text, fontWeight: "600", fontSize: 12, marginBottom: 4 },
  addonNote: { color: colors.dark.textMuted, fontSize: 11.5, lineHeight: 17 },
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
});
