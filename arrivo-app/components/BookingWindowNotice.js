import React from "react";
import { Text, StyleSheet, Linking } from "react-native";
import { Card, Button } from "./UI";
import { colors, spacing } from "../theme/tokens";
import { ON_THE_GO_ONLY_HOURS } from "../utils/bookingWindow";
import { formatLagos } from "../utils/lagosTime";
import { useTranslation } from "react-i18next";

const SUPPORT_PHONE_DIAL = "+2348162706078";

// What we tell WhatsApp when the rider taps through, so Support starts with the
// trip instead of a blank chat.
function whatsappText(prefill) {
  const lines = ["Hello RideArrivo, I need a booking sooner than " + ON_THE_GO_ONLY_HOURS + " hours from now."];
  if (prefill) {
    if (prefill.service) lines.push(`Service: ${prefill.service}`);
    if (prefill.pickupAddress) lines.push(`Pickup: ${prefill.pickupAddress}`);
    if (prefill.destinationAddress) lines.push(`Destination: ${prefill.destinationAddress}`);
    if (prefill.requestedPickupAt) lines.push(`When: ${formatLagos(prefill.requestedPickupAt)}`);
    if (prefill.flightNumber) lines.push(`Flight: ${prefill.flightNumber}`);
  }
  return lines.join("\n");
}

// Shown instead of letting someone confirm a booking that's too close to
// pickup. The brief is explicit that this is never just an error: both ways
// forward have to be on screen together, the form and a human.
//
// prefill carries what the rider already typed into the booking screen
// (pickupAddress, destinationAddress, flightNumber, passengerCount,
// contactPhone, requestedPickupAt as an ISO string, service, details), so On
// the Go opens filled in instead of empty. onUseEarliest, when given, adds a
// one-tap way back to the earliest time a standard booking allows.
export function BookingWindowNotice({ navigation, prefill, onUseEarliest, earliestLabel }) {
  const { t } = useTranslation();
  return (
    <Card tone="dark" style={styles.card}>
      <Text style={styles.title}>{t("bookingWindowNotice.thatSABitClose")}</Text>
      <Text style={styles.meta}>
        {t("bookingWindowNotice.needHours", { hours: ON_THE_GO_ONLY_HOURS })}
        {prefill && prefill.requestedPickupAt
          ? ` ${t("bookingWindowNotice.timePicked", { time: formatLagos(prefill.requestedPickupAt) })}`
          : ""}{" "}
        {t("bookingWindowNotice.quickerOptions")}
      </Text>
      {onUseEarliest ? (
        <Button
          label={earliestLabel || "Use the earliest time"}
          variant="primary"
          style={{ marginTop: spacing.md }}
          onPress={onUseEarliest}
        />
      ) : null}
      <Button
        label={t("bookingWindowNotice.sendItAsAnOn")}
        variant={onUseEarliest ? "ghost" : "primary"}
        tone={onUseEarliest ? "dark" : undefined}
        style={{ marginTop: onUseEarliest ? spacing.sm : spacing.md }}
        onPress={() => navigation.navigate("OnTheGo", prefill ? { prefill } : undefined)}
      />
      <Button
        label={t("bookingWindowNotice.messageUsOnWhatsapp")}
        variant="ghost"
        tone="dark"
        style={{ marginTop: spacing.sm }}
        onPress={() =>
          Linking.openURL(
            `https://wa.me/${SUPPORT_PHONE_DIAL.replace("+", "")}?text=${encodeURIComponent(whatsappText(prefill))}`
          ).catch(() => {})
        }
      />
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { borderColor: colors.amber, borderWidth: 1, marginBottom: spacing.md },
  title: { color: colors.dark.text, fontSize: 14, fontWeight: "700", marginBottom: 6 },
  meta: { color: colors.dark.textMuted, fontSize: 12.5, lineHeight: 18 },
});
