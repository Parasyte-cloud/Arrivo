import React, { useState } from "react";
import { View, Text, StyleSheet, TextInput, Pressable, ActivityIndicator, Modal } from "react-native";
import { colors, spacing, radius } from "../theme/tokens";
import { useAuth } from "../context/AuthContext";
import { deleteAccount } from "../services/api";

// Deleting your account, from inside the app. Both stores require this: an app
// that lets you sign up but only lets you leave by emailing somebody does not
// get approved. The privacy policy promises it too, under NDPA rights.
//
// Confirmation is typing the account email rather than the password, because
// Google and Apple sign-ins are given a random password they have never seen.
// Asking those users for a password would lock them out of their own deletion.

export function DeleteAccountSection() {
  const { user, token, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const accountEmail = String(user?.email || "");
  const matches = typed.trim().toLowerCase() === accountEmail.toLowerCase() && accountEmail.length > 0;

  const close = () => {
    if (busy) return;
    setOpen(false);
    setTyped("");
    setError(null);
  };

  const confirm = async () => {
    setError(null);
    setBusy(true);
    try {
      await deleteAccount(token, typed.trim());
      // The token is dead the moment the server answers, so drop straight to
      // the signed out state rather than showing a success screen the app can
      // no longer load anything for.
      logout();
    } catch (e) {
      setError(e.message || "Couldn't delete your account. Please try again.");
      setBusy(false);
    }
  };

  return (
    <View style={styles.wrap}>
      <Pressable onPress={() => setOpen(true)} accessibilityRole="button">
        <Text style={styles.dangerLink}>Delete my account</Text>
      </Pressable>
      <Text style={styles.note}>
        Removes your details from RideArrivo for good. This can't be undone.
      </Text>

      <Modal visible={open} animationType="slide" transparent onRequestClose={close}>
        <View style={styles.overlay}>
          <View style={styles.card}>
            <Text style={styles.title}>Delete your account?</Text>

            <Text style={styles.body}>
              Your name, contact details, any ID you uploaded, your saved emergency contacts and
              anything you wrote to support are removed, and you won't be able to sign in again.
            </Text>
            <Text style={[styles.body, { marginTop: 10 }]}>
              Past trips stay on file for 7 years because we're required to keep billing records:
              the date, the fare, and the pickup and destination addresses. The exact map
              coordinates, your rating comments and your emergency contact details are removed from
              those too.
            </Text>

            <Text style={styles.label}>Type {accountEmail} to confirm</Text>
            <TextInput
              style={styles.input}
              value={typed}
              onChangeText={setTyped}
              placeholder={accountEmail}
              placeholderTextColor={colors.dark.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              keyboardType="email-address"
              editable={!busy}
            />

            {error ? <Text style={styles.error}>{error}</Text> : null}

            {busy ? (
              <ActivityIndicator color={colors.amber} style={{ marginTop: spacing.md }} />
            ) : (
              <View style={{ marginTop: spacing.md }}>
                {/* Stays disabled until the email matches, so this cannot be
                    tapped through by accident. */}
                <Pressable
                  onPress={confirm}
                  disabled={!matches}
                  style={[styles.deleteBtn, !matches && styles.deleteBtnOff]}
                  accessibilityRole="button"
                >
                  <Text style={[styles.deleteBtnText, !matches && styles.deleteBtnTextOff]}>
                    Delete my account
                  </Text>
                </Pressable>
                <Pressable onPress={close} style={styles.cancelBtn} accessibilityRole="button">
                  <Text style={styles.cancelText}>Keep my account</Text>
                </Pressable>
              </View>
            )}
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: spacing.lg },
  dangerLink: { color: "#FF6B57", fontSize: 14, fontWeight: "700" },
  note: { color: colors.dark.textMuted, fontSize: 11.5, marginTop: 4, lineHeight: 17 },
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "flex-end" },
  card: {
    backgroundColor: colors.cream,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: spacing.lg,
    maxHeight: "85%",
  },
  title: { color: colors.ink, fontSize: 17, fontWeight: "700" },
  body: { color: colors.ink, fontSize: 13.5, lineHeight: 20, marginTop: spacing.sm },
  label: { color: colors.ink, fontSize: 12, fontWeight: "700", marginTop: spacing.md, marginBottom: 6 },
  input: {
    backgroundColor: "rgba(0,0,0,0.05)",
    borderRadius: radius.sm + 2,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    fontSize: 14,
    color: colors.ink,
  },
  error: { color: "#B3261E", fontSize: 12.5, marginTop: spacing.sm, lineHeight: 18 },
  deleteBtn: {
    backgroundColor: "#B3261E",
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: "center",
  },
  deleteBtnOff: { backgroundColor: "rgba(0,0,0,0.12)" },
  deleteBtnText: { color: "#fff", fontWeight: "700", fontSize: 14 },
  deleteBtnTextOff: { color: "rgba(0,0,0,0.35)" },
  cancelBtn: { paddingVertical: 14, alignItems: "center", marginTop: 4 },
  cancelText: { color: colors.ink, fontWeight: "600", fontSize: 14 },
});
