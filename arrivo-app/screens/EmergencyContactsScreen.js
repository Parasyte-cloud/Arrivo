import React, { useEffect, useState } from "react";
import { View, Text, StyleSheet, ScrollView, TextInput, Pressable, ActivityIndicator, KeyboardAvoidingView, Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Card, Button } from "../components/UI";
import { GradientBackground } from "../components/GradientBackground";
import { colors, spacing, radius } from "../theme/tokens";
import { useAuth } from "../context/AuthContext";
import PhoneInput from "../components/PhoneInput";
import { validatePhone, splitPhone, DEFAULT_DIAL } from "../utils/phoneValidation";
import { getEmergencyContacts, addEmergencyContact, deleteEmergencyContact } from "../services/api";

// Real "Emergency contacts" — this used to be a label on Profile with
// nothing behind it at all. A rider saves one or more contacts here once;
// RouteScreen's per-ride "Emergency contact" field (previously retyped from
// scratch on every single booking) now pre-fills from the first one saved
// here, while staying editable per trip.
export default function EmergencyContactsScreen() {
  const insets = useSafeAreaInsets();
  const { token, user } = useAuth();
  const [contacts, setContacts] = useState(null); // null = loading
  const [loadError, setLoadError] = useState(null);
  const [name, setName] = useState("");
  // Contact numbers used to be a single free-text field, so they got saved
  // bare while the rider's own number (signup/profile) went through
  // validatePhone and kept its country code. Same PhoneInput and same
  // validation as everywhere else now, so both are stored in one format.
  // The picker starts on the rider's own country rather than a blanket
  // default — an emergency contact is usually local to them.
  const [phoneDial, setPhoneDial] = useState(() => splitPhone(user?.whatsapp_number || user?.phone).dial || DEFAULT_DIAL);
  const [phoneNational, setPhoneNational] = useState("");
  const [relationship, setRelationship] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [deletingId, setDeletingId] = useState(null);

  const load = () => {
    setLoadError(null);
    getEmergencyContacts(token)
      .then((data) => setContacts(data.contacts || []))
      .catch((e) => setLoadError(e.message || "Couldn't load your emergency contacts."));
  };

  useEffect(load, []);

  const submit = async () => {
    setSaveError(null);
    if (!name.trim()) {
      setSaveError("Please enter a name for this contact.");
      return;
    }
    // Phone errors come from validatePhone itself so they say what's
    // actually wrong ("A Nigeria number should have 10 digits after the
    // country code") instead of a generic "required".
    const phoneResult = validatePhone(phoneDial, phoneNational);
    if (!phoneResult.valid) {
      setSaveError(phoneResult.message);
      return;
    }
    setSaving(true);
    try {
      const data = await addEmergencyContact(token, {
        name: name.trim(),
        phone: phoneResult.full,
        relationship: relationship.trim() || undefined,
      });
      setContacts((prev) => [...(prev || []), data.contact]);
      setName("");
      setPhoneNational("");
      setRelationship("");
    } catch (e) {
      setSaveError(e.message || "Couldn't save this contact. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id) => {
    setDeletingId(id);
    try {
      await deleteEmergencyContact(token, id);
      setContacts((prev) => (prev || []).filter((c) => c.id !== id));
    } catch (e) {
      setLoadError(e.message || "Couldn't remove that contact. Please try again.");
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <View style={styles.screen}>
      <GradientBackground variant="dark" />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 0}>
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + spacing.lg, paddingHorizontal: spacing.lg, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>Emergency contacts</Text>
        <Text style={styles.meta}>
          Save someone we can reach if we can't reach you during a ride. The first contact here fills in automatically
          when you book — you can still edit or clear it per trip.
        </Text>

        {contacts === null && !loadError ? (
          <ActivityIndicator color={colors.amber} style={{ marginVertical: spacing.md }} />
        ) : loadError ? (
          <Text style={styles.errorText}>{loadError}</Text>
        ) : contacts.length === 0 ? (
          <Text style={[styles.meta, { marginTop: spacing.sm }]}>No emergency contacts saved yet.</Text>
        ) : (
          contacts.map((c) => (
            <Card key={c.id} tone="dark" style={{ marginTop: spacing.md }}>
              <View style={{ flexDirection: "row", alignItems: "center" }}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.contactName}>{c.name}</Text>
                  <Text style={styles.meta}>{c.phone}{c.relationship ? ` · ${c.relationship}` : ""}</Text>
                  {/* Contacts saved before this screen required a country
                      code are still stored bare. Nothing here can safely
                      guess one for them, so say so plainly rather than
                      showing a number that may not dial from abroad. */}
                  {c.phone && !c.phone.trim().startsWith("+") ? (
                    <Text style={styles.legacyHint}>Missing a country code — remove and re-add this contact.</Text>
                  ) : null}
                </View>
                <Pressable onPress={() => remove(c.id)} disabled={deletingId === c.id} hitSlop={8}>
                  {deletingId === c.id ? (
                    <ActivityIndicator color={colors.coral} size="small" />
                  ) : (
                    <Text style={styles.removeLink}>Remove</Text>
                  )}
                </Pressable>
              </View>
            </Card>
          ))
        )}

        <Card tone="dark" style={{ marginTop: spacing.lg }}>
          <Text style={styles.cardLabel}>Add a contact</Text>
          <TextInput
            style={styles.input}
            placeholder="Contact name"
            placeholderTextColor={colors.dark.textMuted}
            value={name}
            onChangeText={setName}
          />
          <PhoneInput
            tone="dark"
            dial={phoneDial}
            national={phoneNational}
            onChangeDial={setPhoneDial}
            onChangeNational={setPhoneNational}
            placeholder="Phone number"
          />
          <TextInput
            style={styles.input}
            placeholder="Relationship (optional)"
            placeholderTextColor={colors.dark.textMuted}
            value={relationship}
            onChangeText={setRelationship}
          />
          {saveError ? <Text style={styles.errorText}>{saveError}</Text> : null}
          {saving ? (
            <ActivityIndicator color={colors.amber} />
          ) : (
            <Button label="Save contact" onPress={submit} variant="primary" />
          )}
        </Card>
      </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.dark.bg0 },
  title: { fontSize: 19, fontWeight: "700", color: colors.dark.text, marginBottom: spacing.sm },
  meta: { color: colors.dark.textMuted, fontSize: 12.5, lineHeight: 18 },
  cardLabel: { color: colors.dark.text, fontWeight: "600", fontSize: 12, marginBottom: 10 },
  contactName: { color: colors.dark.text, fontSize: 14, fontWeight: "700" },
  removeLink: { color: colors.coral, fontSize: 12.5, fontWeight: "600" },
  legacyHint: { color: colors.amber, fontSize: 11, marginTop: 3 },
  errorText: { color: "#FF9B8A", fontSize: 11.5, marginTop: 4, marginBottom: 8 },
  input: {
    backgroundColor: colors.dark.fieldBg,
    color: colors.dark.text,
    borderRadius: radius.sm + 2,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    fontSize: 13,
    marginBottom: spacing.sm,
  },
});
