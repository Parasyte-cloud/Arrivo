import React, { useEffect, useRef, useState } from "react";
import { ScrollView, Pressable, Text, StyleSheet } from "react-native";
import { useTranslation } from "react-i18next";
import { colors, spacing, tint } from "../theme/tokens";
import { SERVICES } from "../utils/services";
import { useAuth } from "../context/AuthContext";
import { getInstantStatus } from "../services/api";

// One row to move between every service. Express shows only once Ops has
// switched it on for the whole app; everything else is always there.
export default function ServiceSwitcher({ current, onSelect, expressEnabled }) {
  const { t } = useTranslation();
  const { token } = useAuth();
  // When the screen does not already know, ask once whether Express is on.
  const [asked, setAsked] = useState(false);
  useEffect(() => {
    if (expressEnabled !== undefined || !token) return undefined;
    let off = false;
    getInstantStatus(token).then((r) => { if (!off) setAsked(!!r.enabled); }).catch(() => {});
    return () => { off = true; };
  }, [expressEnabled, token]);
  // Keep the chosen service in view: Removals sits past the edge on a small phone.
  const scroller = useRef(null);
  const xs = useRef({});
  const scrollToCurrent = () => { const x = xs.current[current]; if (x != null && scroller.current) scroller.current.scrollTo({ x: Math.max(0, x - 16), animated: false }); };
  useEffect(scrollToCurrent, [current]);
  const showExpress = expressEnabled === undefined ? asked : expressEnabled;
  return (
    <ScrollView ref={scroller} onContentSizeChange={scrollToCurrent} horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row} keyboardShouldPersistTaps="handled">
      {SERVICES.filter((s) => s.id !== "express" || showExpress).map((s) => {
        const on = s.id === current;
        return (
          <Pressable key={s.id} onLayout={(e) => { xs.current[s.id] = e.nativeEvent.layout.x; if (s.id === current) scrollToCurrent(); }} onPress={() => onSelect(s.id)} style={[styles.chip, on && styles.chipOn]} accessibilityRole="button" accessibilityState={{ selected: on }}>
            <Text style={[styles.text, on && styles.textOn]}>{t(`services.${s.id}`)}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  row: { paddingVertical: spacing.sm, gap: 8 },
  chip: { paddingHorizontal: 16, paddingVertical: 9, borderRadius: 999, borderWidth: 1, borderColor: tint(0.18), backgroundColor: colors.sheet, marginRight: 8 },
  chipOn: { backgroundColor: colors.fill, borderColor: colors.fill },
  text: { fontSize: 13.5, fontWeight: "700", color: colors.ink },
  textOn: { color: "#FFFFFF" },
});
