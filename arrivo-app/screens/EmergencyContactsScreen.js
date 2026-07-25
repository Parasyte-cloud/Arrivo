import React, { useEffect, useState } from "react";
import { View, Text, StyleSheet, ScrollView, TextInput, Pressable, ActivityIndicator, KeyboardAvoidingView, Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Card, Button } from "../components/UI";
import { GradientBackground } from "../components/GradientBackground";
import { colors, spacing, radius } from "../theme/tokens";
import { useAuth } from "../context/AuthContext";
import { getEmergencyContacts, addEmergencyContact, deleteEmergencyContact } from "../services/api";

// Real "Emergency contacts" — this used to be a label on Profile with
// nothing behind it at all. A rider saves one or more contacts here once;
// RouteScreen's per-ride "Emergency contact" field (previously retyped from
// scratch on every single booking) now pre-fills from the first one saved
// here, while staying editable per trip.
export default function EmergencyContactsScreen() {
  const insets = useSafeAreaInsets();
  const { token } = useAuth();
  const [contacts, setContacts] = useState(null); // null = loading
  const [loadError, setLoadError] = useState(null);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
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
    if (!name.trim() || !phone.trim()) {
      setSaveError("Name and phone number are required.");
      return;
    }
    setSaving(true);
    try {
      const data = await addEmergencyContact(token, {
        name: name.trim(),
        phone: phone.trim(),
        relationship: relationship.trim() || undefined,
      });
      setContacts((prev) => [...(prev || []), data.contact]);
      setName("");
      setPhone("");
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
          <TextInput
            style={styles.input}
            placeholder="Phone number"
            placeholderTextColor={colors.dark.textMuted}
            value={phone}
            onChangeText={setPhone}
            keyboardType="phone-pad"
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
