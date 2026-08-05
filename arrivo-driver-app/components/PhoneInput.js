import React, { useState } from "react";
import { View, Text, TextInput, Pressable, Modal, FlatList, StyleSheet } from "react-native";
import { colors, spacing } from "../theme/tokens";
import { COUNTRY_CODES } from "../utils/phoneValidation";

// The single phone-entry control for the whole app. Every field that takes
// a phone number uses this so a country code is never optional and never
// silently missing — see utils/phoneValidation.js for the storage format.
// Kept identical to arrivo-app/components/PhoneInput.js (same tokens, same
// behaviour) so a driver and a rider enter a number the same way.
//
// tone="dark" is for the post-login glass screens; the default light tone
// is for Login/Signup and the driver-profile setup, which stay on the
// cream background.
export default function PhoneInput({ dial, national, onChangeDial, onChangeNational, placeholder, tone = "light" }) {
  const [pickerVisible, setPickerVisible] = useState(false);
  const selected = COUNTRY_CODES.find((c) => c.dial === dial) || COUNTRY_CODES[0];
  const dark = tone === "dark";

  return (
    <View style={styles.row}>
      <Pressable style={[styles.dialButton, dark && styles.dialButtonDark]} onPress={() => setPickerVisible(true)}>
        <Text style={[styles.dialText, dark && styles.textDark]}>{selected.code} {selected.dial}</Text>
      </Pressable>
      <TextInput
        style={[styles.numberInput, dark && styles.numberInputDark]}
        placeholder={placeholder || "Phone number"}
        placeholderTextColor={dark ? colors.dark.textMuted : colors.textMuted}
        value={national}
        onChangeText={onChangeNational}
        keyboardType="phone-pad"
      />

      <Modal visible={pickerVisible} animationType="slide" transparent onRequestClose={() => setPickerVisible(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Choose a country code</Text>
            <FlatList
              data={COUNTRY_CODES}
              keyExtractor={(item) => item.code}
              renderItem={({ item }) => (
                <Pressable
                  style={styles.countryRow}
                  onPress={() => {
                    onChangeDial(item.dial);
                    setPickerVisible(false);
                  }}
                >
                  <Text style={styles.countryName}>{item.name}</Text>
                  <Text style={styles.countryDial}>{item.dial}</Text>
                </Pressable>
              )}
              style={{ maxHeight: 360 }}
            />
            <Pressable style={styles.closeBtn} onPress={() => setPickerVisible(false)}>
              <Text style={styles.closeBtnText}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", gap: 8, marginBottom: spacing.sm },
  dialButton: {
    backgroundColor: colors.fieldBg, borderRadius: 12, paddingHorizontal: 12,
    justifyContent: "center", minWidth: 90,
  },
  dialButtonDark: { backgroundColor: colors.dark.fieldBg },
  dialText: { color: colors.ink, fontSize: 13, fontWeight: "600" },
  textDark: { color: colors.dark.text },
  numberInput: {
    flex: 1, backgroundColor: colors.fieldBg, color: colors.ink, borderRadius: 12,
    paddingHorizontal: spacing.md, paddingVertical: 14, fontSize: 14,
  },
  numberInputDark: { backgroundColor: colors.dark.fieldBg, color: colors.dark.text },
  modalOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "flex-end" },
  modalCard: { backgroundColor: colors.cream, borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: "70%", padding: 20 },
  modalTitle: { fontWeight: "700", fontSize: 15, color: colors.ink, marginBottom: 12 },
  countryRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: "#eee" },
  countryName: { fontSize: 14, color: colors.ink },
  countryDial: { fontSize: 14, color: colors.ink, fontWeight: "600" },
  closeBtn: { marginTop: 12, alignItems: "center", padding: 10 },
  closeBtnText: { color: colors.coral, fontWeight: "700" },
});
