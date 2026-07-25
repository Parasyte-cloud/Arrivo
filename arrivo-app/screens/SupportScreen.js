import React from "react";
import { View, Text, StyleSheet, ScrollView, Pressable, Linking } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Card } from "../components/UI";
import { GradientBackground } from "../components/GradientBackground";
import { colors, spacing } from "../theme/tokens";

// Real contact info for RideArrivo (RICHATHAOIR LIMITED) — same
// info@ridearrivo.com address already used across the website's
// privacy/terms pages and account.html's "Send email" button, and the same
// phone number already live on the website's footer call/WhatsApp links, so
// this doesn't introduce a second, inconsistent contact channel.
const SUPPORT_EMAIL = "info@ridearrivo.com";
const SUPPORT_PHONE_DISPLAY = "+234 816 270 6078";
const SUPPORT_PHONE_DIAL = "+2348162706078";

const FAQS = [
  {
    q: "What's the cancellation policy?",
    a: "Cancel more than 48 hours before pickup for a full refund. Inside 48 hours, you'll get a 50% refund.",
  },
  {
    q: "How do I pay?",
    a: "Card, wallet balance, or an active membership — all handled in the app at checkout. Fares are always confirmed before you pay.",
  },
  {
    q: "Can I tip my driver?",
    a: "Yes — after a trip is marked completed, you can add a tip from your wallet or a card, right from that trip's screen.",
  },
  {
    q: "Do I need to verify my ID?",
    a: "Verifying your ID (Profile → Verified ID) helps keep every trip safer for riders and drivers alike. You can still book before it's approved.",
  },
  {
    q: "How does flight tracking work for airport pickups?",
    a: "Add your flight number when booking and we'll track it automatically, adjusting your pickup time for delays.",
  },
];

function openSafely(url) {
  Linking.openURL(url).catch(() => {});
}

export default function SupportScreen() {
  const insets = useSafeAreaInsets();

  return (
    <View style={styles.screen}>
      <GradientBackground variant="dark" />
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + spacing.lg, paddingHorizontal: spacing.lg, paddingBottom: 40 }}>
        <Text style={styles.title}>Support</Text>
        <Text style={styles.meta}>Reach us directly, or check the answers below first — most questions are covered there.</Text>

        <Card tone="dark" style={{ marginTop: spacing.lg }}>
          <Pressable style={styles.contactRow} onPress={() => openSafely(`mailto:${SUPPORT_EMAIL}`)}>
            <Text style={styles.contactIcon}>✉️</Text>
            <View style={{ flex: 1 }}>
              <Text style={styles.contactLabel}>Email us</Text>
              <Text style={styles.meta}>{SUPPORT_EMAIL}</Text>
            </View>
          </Pressable>
          <View style={styles.divider} />
          <Pressable style={styles.contactRow} onPress={() => openSafely(`tel:${SUPPORT_PHONE_DIAL}`)}>
            <Text style={styles.contactIcon}>📞</Text>
            <View style={{ flex: 1 }}>
              <Text style={styles.contactLabel}>Call us</Text>
              <Text style={styles.meta}>{SUPPORT_PHONE_DISPLAY}</Text>
            </View>
          </Pressable>
          <View style={styles.divider} />
          <Pressable style={styles.contactRow} onPress={() => openSafely(`https://wa.me/${SUPPORT_PHONE_DIAL.replace("+", "")}`)}>
            <Text style={styles.contactIcon}>💬</Text>
            <View style={{ flex: 1 }}>
              <Text style={styles.contactLabel}>WhatsApp us</Text>
              <Text style={styles.meta}>{SUPPORT_PHONE_DISPLAY}</Text>
            </View>
          </Pressable>
        </Card>

        <Text style={styles.sectionTitle}>Common questions</Text>
        {FAQS.map((item, i) => (
          <Card key={i} tone="dark" style={{ marginBottom: spacing.sm }}>
            <Text style={styles.faqQ}>{item.q}</Text>
            <Text style={[styles.meta, { marginTop: 6 }]}>{item.a}</Text>
          </Card>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.dark.bg0 },
  title: { fontSize: 19, fontWeight: "700", color: colors.dark.text, marginBottom: spacing.sm },
  meta: { color: colors.dark.textMuted, fontSize: 12.5, lineHeight: 18 },
  sectionTitle: { color: colors.dark.text, fontWeight: "700", fontSize: 14, marginTop: spacing.lg, marginBottom: 10 },
  contactRow: { flexDirection: "row", alignItems: "center", gap: spacing.md, paddingVertical: 4 },
  contactIcon: { fontSize: 20 },
  contactLabel: { color: colors.dark.text, fontSize: 14, fontWeight: "700" },
  divider: { height: 1, backgroundColor: colors.dark.hairline, marginVertical: spacing.sm },
  faqQ: { color: colors.dark.text, fontSize: 13.5, fontWeight: "700" },
});
