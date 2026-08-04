import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  Linking,
  TextInput,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Card, Button } from "../components/UI";
import { GradientBackground } from "../components/GradientBackground";
import { colors, spacing, radius } from "../theme/tokens";
import { useAuth } from "../context/AuthContext";
import { createSupportTicket, getRideHistory } from "../services/api";

// Same info@ridearrivo.com and phone number the website already uses on its
// privacy/terms pages and footer, so we're not spinning up a second contact
// channel nobody watches.
const SUPPORT_EMAIL = "info@ridearrivo.com";
const SUPPORT_PHONE_DISPLAY = "+234 816 270 6078";
const SUPPORT_PHONE_DIAL = "+2348162706078";

// Matches the TYPES list the backend validates against in routes/support.js.
// Change one and you have to change the other.
const TICKET_TYPES = [
  { value: "complaint", label: "Complaint", hint: "Something went wrong and you want us to look into it." },
  { value: "inquiry", label: "Inquiry", hint: "You want to know how something works." },
  { value: "support", label: "Support", hint: "You need a hand with a booking or your account." },
];

// A trip that hasn't finished or been called off yet. Anything else is history.
const ACTIVE_STATUSES = ["requested", "accepted", "in_progress"];

const MAX_SUBJECT = 140;
const MAX_DESCRIPTION = 4000;

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

// If a trip is live that's almost certainly what they're writing in about, so
// grab that first and only fall back to the last one they booked. /api/rides/
// mine is already newest first, so find() gives us the newest live one.
function pickBooking(rides) {
  return rides.find((r) => ACTIVE_STATUSES.includes(r.ride_status)) || rides[0] || null;
}

// Short one-liner for the booking we're attaching. stops comes back already
// parsed into an array from the backend, and the last one is the destination.
function describeRide(ride) {
  const stops = Array.isArray(ride.stops) ? ride.stops.filter(Boolean) : [];
  const destination = stops.length ? stops[stops.length - 1] : null;
  const when = ride.created_at ? new Date(ride.created_at).toLocaleDateString() : null;
  const route = destination ? `${ride.pickup_address} to ${destination}` : ride.pickup_address;
  return when ? `${route} · ${when}` : route;
}

export default function SupportScreen() {
  const insets = useSafeAreaInsets();
  const { token } = useAuth();

  const [type, setType] = useState(null);
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState(null);
  const [sentTicket, setSentTicket] = useState(null);

  // undefined = still loading, null = they've never booked
  const [attachedRide, setAttachedRide] = useState(undefined);

  useEffect(() => {
    let cancelled = false;
    getRideHistory(token)
      .then((data) => {
        if (cancelled) return;
        setAttachedRide(pickBooking(data.rides || []));
      })
      // Not being able to attach a booking shouldn't stop someone reporting a
      // problem, so swallow this and just send the ticket without one.
      .catch(() => {
        if (!cancelled) setAttachedRide(null);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const submit = async () => {
    setSendError(null);
    if (!subject.trim()) {
      setSendError("Give your message a short subject.");
      return;
    }
    if (!description.trim()) {
      setSendError("Tell us a bit more about what's going on.");
      return;
    }
    setSending(true);
    try {
      const data = await createSupportTicket(token, {
        type,
        subject: subject.trim(),
        description: description.trim(),
        rideId: attachedRide ? attachedRide.id : undefined,
      });
      setSentTicket(data.ticket);
      setType(null);
      setSubject("");
      setDescription("");
    } catch (e) {
      setSendError(e.message || "Couldn't send that. Please try again.");
    } finally {
      setSending(false);
    }
  };

  return (
    <View style={styles.screen}>
      <GradientBackground variant="dark" />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 0}
      >
        <ScrollView
          contentContainerStyle={{
            paddingTop: insets.top + spacing.lg,
            paddingHorizontal: spacing.lg,
            paddingBottom: 40,
          }}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={styles.title}>Support</Text>
          <Text style={styles.meta}>
            Send us a message and we'll come back to you, or reach us directly below. The answers
            further down cover most questions.
          </Text>

          {sentTicket ? (
            <Card tone="dark" style={{ marginTop: spacing.lg }}>
              <Text style={styles.successTitle}>Thanks, we've got it</Text>
              <Text style={[styles.meta, { marginTop: 6 }]}>
                Your reference is #{sentTicket.id}. We'll reply by email at the address on your
                account.
              </Text>
              <Button
                label="Send another message"
                variant="ghost"
                tone="dark"
                style={{ marginTop: spacing.md }}
                onPress={() => setSentTicket(null)}
              />
            </Card>
          ) : (
            <Card tone="dark" style={{ marginTop: spacing.lg }}>
              <Text style={styles.cardLabel}>What's this about?</Text>
              <View style={styles.typeRow}>
                {TICKET_TYPES.map((t) => {
                  const selected = type === t.value;
                  return (
                    <Pressable
                      key={t.value}
                      onPress={() => {
                        setType(t.value);
                        setSendError(null);
                      }}
                      style={[styles.typeChip, selected && styles.typeChipOn]}
                    >
                      <Text style={[styles.typeChipText, selected && styles.typeChipTextOn]}>
                        {t.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>

              {/* Rest of the form only shows once they've picked a type, so the
                  choice is made first instead of being an afterthought at the
                  bottom of a form they've already filled in. */}
              {type ? (
                <View style={{ marginTop: spacing.md }}>
                  <Text style={styles.typeHint}>
                    {TICKET_TYPES.find((t) => t.value === type).hint}
                  </Text>

                  <TextInput
                    style={styles.input}
                    placeholder="Subject"
                    placeholderTextColor={colors.dark.textMuted}
                    value={subject}
                    onChangeText={setSubject}
                    maxLength={MAX_SUBJECT}
                  />
                  <TextInput
                    style={[styles.input, styles.textArea]}
                    placeholder="Tell us what happened, with as much detail as you can"
                    placeholderTextColor={colors.dark.textMuted}
                    value={description}
                    onChangeText={setDescription}
                    maxLength={MAX_DESCRIPTION}
                    multiline
                    textAlignVertical="top"
                  />

                  {attachedRide === undefined ? (
                    <Text style={styles.attachNote}>Checking your recent bookings...</Text>
                  ) : attachedRide ? (
                    <View style={styles.attachBox}>
                      <Text style={styles.attachLabel}>
                        {ACTIVE_STATUSES.includes(attachedRide.ride_status)
                          ? `Attaching your current booking (#${attachedRide.id})`
                          : `Attaching your most recent booking (#${attachedRide.id})`}
                      </Text>
                      <Text style={styles.meta}>{describeRide(attachedRide)}</Text>
                    </View>
                  ) : (
                    <Text style={styles.attachNote}>
                      No bookings on your account yet, so there's nothing to attach.
                    </Text>
                  )}

                  {sendError ? <Text style={styles.errorText}>{sendError}</Text> : null}

                  {sending ? (
                    <ActivityIndicator color={colors.amber} style={{ marginTop: spacing.sm }} />
                  ) : (
                    <Button
                      label="Send message"
                      variant="primary"
                      onPress={submit}
                      style={{ marginTop: spacing.sm }}
                    />
                  )}
                </View>
              ) : null}
            </Card>
          )}

          <Text style={styles.sectionTitle}>Reach us directly</Text>
          <Card tone="dark">
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
            <Pressable
              style={styles.contactRow}
              onPress={() => openSafely(`https://wa.me/${SUPPORT_PHONE_DIAL.replace("+", "")}`)}
            >
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
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.dark.bg0 },
  title: { fontSize: 19, fontWeight: "700", color: colors.dark.text, marginBottom: spacing.sm },
  meta: { color: colors.dark.textMuted, fontSize: 12.5, lineHeight: 18 },
  sectionTitle: {
    color: colors.dark.text,
    fontWeight: "700",
    fontSize: 14,
    marginTop: spacing.lg,
    marginBottom: 10,
  },
  cardLabel: { color: colors.dark.text, fontWeight: "600", fontSize: 12, marginBottom: 10 },
  successTitle: { color: colors.dark.text, fontSize: 14, fontWeight: "700" },
  typeRow: { flexDirection: "row", gap: spacing.sm },
  typeChip: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: radius.sm + 2,
    borderWidth: 1,
    borderColor: colors.dark.surfaceBorder,
    backgroundColor: colors.dark.fieldBg,
    alignItems: "center",
  },
  typeChipOn: { borderColor: colors.amber, backgroundColor: "rgba(244,163,0,0.16)" },
  typeChipText: { color: colors.dark.textMuted, fontSize: 12.5, fontWeight: "600" },
  typeChipTextOn: { color: colors.amber, fontWeight: "700" },
  typeHint: { color: colors.dark.textMuted, fontSize: 11.5, marginBottom: spacing.sm },
  input: {
    backgroundColor: colors.dark.fieldBg,
    color: colors.dark.text,
    borderRadius: radius.sm + 2,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    fontSize: 13,
    marginBottom: spacing.sm,
  },
  textArea: { minHeight: 120, paddingTop: 12 },
  attachBox: {
    backgroundColor: "rgba(255,255,255,0.06)",
    borderRadius: radius.sm + 2,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  attachLabel: { color: colors.dark.text, fontSize: 12, fontWeight: "700", marginBottom: 4 },
  attachNote: { color: colors.dark.textMuted, fontSize: 11.5, marginBottom: spacing.sm },
  errorText: { color: "#FF9B8A", fontSize: 11.5, marginTop: 4, marginBottom: 8 },
  contactRow: { flexDirection: "row", alignItems: "center", gap: spacing.md, paddingVertical: 4 },
  contactIcon: { fontSize: 20 },
  contactLabel: { color: colors.dark.text, fontSize: 14, fontWeight: "700" },
  divider: { height: 1, backgroundColor: colors.dark.hairline, marginVertical: spacing.sm },
  faqQ: { color: colors.dark.text, fontSize: 13.5, fontWeight: "700" },
});
