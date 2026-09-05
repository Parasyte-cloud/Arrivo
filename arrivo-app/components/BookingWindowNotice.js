import React from "react";
import { Text, StyleSheet, Linking } from "react-native";
import { Card, Button } from "./UI";
import { colors, spacing } from "../theme/tokens";
import { ON_THE_GO_ONLY_HOURS } from "../utils/bookingWindow";

const SUPPORT_PHONE_DIAL = "+2348162706078";

// Shown instead of letting someone confirm a booking that's too close to
// pickup. The brief is explicit that this is never just an error: both ways
// forward have to be on screen together, the form and a human.
export function BookingWindowNotice({ navigation }) {
  return (
    <Card tone="dark" style={styles.card}>
      <Text style={styles.title}>That's a bit close for a standard booking</Text>
      <Text style={styles.meta}>
        We need about {ON_THE_GO_ONLY_HOURS} hours to arrange a car the normal way. You've still got
        two quicker options.
      </Text>
      <Button
        label="Book with On the Go"
        variant="primary"
        style={{ marginTop: spacing.md }}
        onPress={() => navigation.navigate("OnTheGo")}
      />
      <Button
        label="Message us on WhatsApp"
        variant="ghost"
        tone="dark"
        style={{ marginTop: spacing.sm }}
        onPress={() =>
          Linking.openURL(`https://wa.me/${SUPPORT_PHONE_DIAL.replace("+", "")}`).catch(() => {})
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
