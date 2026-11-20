import React from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { useTranslation } from "react-i18next";
import { supportedLanguages, setAppLanguage } from "../i18n";
import { colors, spacing } from "../theme/tokens";

// Names are shown in their own language so a rider can always find theirs,
// whatever language the screen is currently in.
export const LANGUAGE_LABELS = { en: "English", fr: "Français", zh: "中文", de: "Deutsch", hi: "हिन्दी", es: "Español", pt: "Português" };

// Compact language row for the signed-out screens (Login, Signup). Signed-in
// riders change language in Profile, which also saves it to their account.
export default function LanguageChips() {
  const { i18n } = useTranslation();
  return (
    <View style={styles.row} accessibilityRole="radiogroup">
      {supportedLanguages.map((code) => {
        const active = i18n.language === code;
        return (
          <Pressable
            key={code}
            onPress={() => setAppLanguage(code)}
            accessibilityRole="radio"
            accessibilityState={{ selected: active }}
            accessibilityLabel={LANGUAGE_LABELS[code]}
            style={[styles.chip, active && styles.chipActive]}
          >
            <Text style={[styles.text, active && styles.textActive]}>{LANGUAGE_LABELS[code]}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 8, marginTop: spacing.md },
  chip: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999, borderWidth: 1, borderColor: "rgba(18,18,59,0.25)", minHeight: 34, justifyContent: "center" },
  chipActive: { backgroundColor: colors.ink, borderColor: colors.ink },
  text: { fontSize: 13, color: colors.ink, fontWeight: "600" },
  textActive: { color: "#FFFFFF" },
});
