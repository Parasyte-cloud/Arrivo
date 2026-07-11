import React, { useState } from "react";
import { View, Text, TextInput, Pressable, Modal, FlatList, StyleSheet } from "react-native";
import { colors, spacing, radius } from "../theme/tokens";
import { COUNTRY_CODES } from "../utils/phoneValidation";

export default function PhoneInput({ dial, national, onChangeDial, onChangeNational, placeholder }) {
  const [pickerVisible, setPickerVisible] = useState(false);
  const selected = COUNTRY_CODES.find((c) => c.dial === dial) || COUNTRY_CODES[0];

  return (
    <View style={styles.row}>
      <Pressable style={styles.dialButton} onPress={() => setPickerVisible(true)}>
        <Text style={styles.dialText}>{selected.code} {selected.dial}</Text>
      </Pressable>
      <TextInput
        style={styles.numberInput}
        placeholder={placeholder || "Phone number"}
        placeholderTextColor={colors.textMuted}
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
  dialText: { color: colors.cream, fontSize: 13, fontWeight: "600" },
  numberInput: {
    flex: 1, backgroundColor: colors.fieldBg, color: colors.cream, borderRadius: 12,
    paddingHorizontal: spacing.md, paddingVertical: 14, fontSize: 14,
  },
  modalOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "flex-end" },
  modalCard: { backgroundColor: colors.cream, borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: "70%", padding: 20 },
  modalTitle: { fontWeight: "700", fontSize: 15, color: colors.ink, marginBottom: 12 },
  countryRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: "#eee" },
  countryName: { fontSize: 14, color: colors.ink },
  countryDial: { fontSize: 14, color: colors.ink, fontWeight: "600" },
  closeBtn: { marginTop: 12, alignItems: "center", padding: 10 },
  closeBtnText: { color: colors.coral, fontWeight: "700" },
});
