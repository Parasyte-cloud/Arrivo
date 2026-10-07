import React from "react";
import { View, Text, StyleSheet, ScrollView, Pressable, Modal, Linking } from "react-native";
import { colors } from "../theme/tokens";
import { PRIVACY_SECTIONS, PRIVACY_LAST_UPDATED, PRIVACY_FULL_URL } from "../utils/privacyPolicy";

// The privacy notice shown at signup. Pulled out of SignupScreen so it can be
// rendered on its own: the screen reaches AuthContext, which imports the
// Stream video SDK, and that will not build outside a native app. Nothing in
// here touches anything but react-native, the tokens and the copy, so it can
// be mounted in isolation to actually look at it.
//
// The agree button sits outside the ScrollView on purpose. The copy is long
// enough to scroll and the button has to stay reachable without hunting for
// the bottom.

// The URL was plain text, so tapping it did nothing. Opens in the phone's
// browser now. Swallow the rejection: openURL throws when nothing can handle
// the link, and there is nothing useful to tell the rider at that point.
function openFullPolicy() {
  Linking.openURL(`https://${PRIVACY_FULL_URL}`).catch(() => {});
}

export function PrivacyPolicyModal({ visible, onClose, onAgree }) {
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.modalOverlay}>
        <View style={styles.modalCard}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Data Protection &amp; Privacy Policy</Text>
            <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close">
              <Text style={styles.modalClose}>✕</Text>
            </Pressable>
          </View>

          <ScrollView style={styles.modalBody} contentContainerStyle={styles.modalBodyContent}>
            <Text style={styles.modalUpdated}>Last updated {PRIVACY_LAST_UPDATED}</Text>
            {PRIVACY_SECTIONS.map((section) => (
              <View key={section.title} style={styles.modalSection}>
                <Text style={styles.modalSectionTitle}>{section.title}</Text>
                <Text style={styles.modalText}>{section.body}</Text>
              </View>
            ))}
            <Text style={styles.modalText}>
              This is a summary. For the full policy, visit{" "}
              <Text style={styles.modalLink} onPress={openFullPolicy}>
                {PRIVACY_FULL_URL}
              </Text>
              .
            </Text>
          </ScrollView>

          <Pressable style={styles.modalAgreeBtn} onPress={onAgree}>
            <Text style={styles.modalAgreeBtnText}>I've read this. I agree</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  modalOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "flex-end" },
  modalCard: { backgroundColor: colors.cream, borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: "75%" },
  modalHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", padding: 20, borderBottomWidth: 1, borderBottomColor: "#e5e5e5" },
  modalTitle: { fontWeight: "700", fontSize: 15, color: colors.ink, flex: 1 },
  modalClose: { fontSize: 18, color: "#888", paddingHorizontal: 8 },
  modalBody: { flexShrink: 1 },
  modalBodyContent: { padding: 20 },
  modalText: { color: colors.ink, fontSize: 13.5, lineHeight: 20 },
  modalLink: { color: colors.ink, fontWeight: "700", textDecorationLine: "underline" },
  modalUpdated: { color: "#666", fontSize: 11.5, marginBottom: 14 },
  modalSection: { marginBottom: 14 },
  modalSectionTitle: { color: colors.ink, fontWeight: "700", fontSize: 13, marginBottom: 4 },
  modalAgreeBtn: { backgroundColor: colors.amber, margin: 20, marginTop: 0, padding: 14, borderRadius: 12, alignItems: "center" },
  modalAgreeBtnText: { color: colors.ink, fontWeight: "700", fontSize: 14 },
});
