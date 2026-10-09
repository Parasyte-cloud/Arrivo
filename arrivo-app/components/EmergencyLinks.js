import React from "react";
import { View, Text, Pressable, StyleSheet, Linking } from "react-native";
import { colors, spacing } from "../theme/tokens";
import {
  EMERGENCY_ONLY_NOTE,
  EMERGENCY_PRIVACY_URL,
  EMERGENCY_TERMS_URL,
  EMERGENCY_PRIVACY_LABEL,
  EMERGENCY_TERMS_LABEL,
} from "../utils/emergencyCopy";

// The one-line reminder and the links to the website's privacy policy and
// terms that sit under the Emergency Button. The legal text is not copied
// here, it is only linked.
export default function EmergencyLinks() {
  const open = (url) => Linking.openURL(url).catch(() => {});
  return (
    <View style={styles.wrap}>
      <Text style={styles.note}>{EMERGENCY_ONLY_NOTE}</Text>
      <View style={styles.row}>
        <Pressable accessibilityRole="link" onPress={() => open(EMERGENCY_PRIVACY_URL)}>
          <Text style={styles.link}>{EMERGENCY_PRIVACY_LABEL}</Text>
        </Pressable>
        <Text style={styles.sep}> · </Text>
        <Pressable accessibilityRole="link" onPress={() => open(EMERGENCY_TERMS_URL)}>
          <Text style={styles.link}>{EMERGENCY_TERMS_LABEL}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: spacing.sm, alignItems: "center" },
  note: { color: colors.dark.textMuted, fontSize: 12, textAlign: "center" },
  row: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", marginTop: 4 },
  link: { color: colors.tealBright, fontSize: 12, fontWeight: "600", textDecorationLine: "underline" },
  sep: { color: colors.dark.textMuted, fontSize: 12 },
});
