import React, { useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, ScrollView } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useTranslation } from "react-i18next";
import { GradientBackground } from "../components/GradientBackground";
import ParasyteSignature from "../components/ParasyteSignature";
import TierSwitcher from "../tiers/TierSwitcher";
import { PANELS } from "../tiers/panels";
import { pickStartTier, visibleTiers } from "../tiers/registry";
import { colors, spacing } from "../theme/tokens";
import { getInstantStatus } from "../services/api";
import { useAuth } from "../context/AuthContext";

const LAST_TIER_KEY = "arrivo_last_tier";

// Home is the shell. It knows the list of tiers and nothing about what is
// inside them: pick one at the top, the tier's own panel appears below.
export default function HomeScreen({ navigation }) {
  const { t } = useTranslation();
  const { user, token } = useAuth();
  const [flags, setFlags] = useState({ expressEnabled: false });
  const [activeId, setActiveId] = useState("ride");
  const [restored, setRestored] = useState(false);

  // ArrivoExpress ships behind a rollout gate (arrivo-backend routes/
  // instantRides.js). It only appears once switched on, so Home never shows a
  // dead end. If the check fails, it simply stays hidden.
  useEffect(() => {
    let cancelled = false;
    if (!token) return undefined;
    getInstantStatus(token)
      .then((status) => {
        if (!cancelled) setFlags({ expressEnabled: !!status.enabled });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [token]);

  // Reopen on the tier used last, once, if it is still on offer.
  useEffect(() => {
    let cancelled = false;
    AsyncStorage.getItem(LAST_TIER_KEY)
      .then((saved) => {
        if (!cancelled && saved) setActiveId(saved);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setRestored(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const tiers = useMemo(() => visibleTiers(flags), [flags]);
  // If the saved tier is not available (Express switched off), fall back safely.
  const shownId = restored ? pickStartTier(activeId, flags) : "ride";
  const Panel = PANELS[shownId] || PANELS.ride;

  const choose = (id) => {
    setActiveId(id);
    AsyncStorage.setItem(LAST_TIER_KEY, id).catch(() => {});
  };

  return (
    <View style={styles.screen}>
      <GradientBackground variant="dark" />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.greet}>{t("home.greeting", { name: user?.name?.split(" ")[0] || "there" })}</Text>
        <Text style={styles.sub}>{t("home.whereTo")}</Text>

        <View style={{ height: spacing.md }} />
        <TierSwitcher tiers={tiers} activeId={shownId} onChange={choose} />

        <View style={{ height: spacing.lg }} />
        <Panel navigation={navigation} token={token} user={user} />

        <ParasyteSignature />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.dark.bg0 },
  content: { padding: spacing.lg, paddingBottom: 40 },
  greet: { fontSize: 19, fontWeight: "700", color: colors.dark.text },
  sub: { fontSize: 12, color: colors.dark.textMuted, marginTop: 2 },
});
