import React, { useCallback, useState } from "react";
import { View, Text, StyleSheet, ScrollView, ActivityIndicator, RefreshControl } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect } from "@react-navigation/native";
import { Card, Tag } from "../components/UI";
import { GradientBackground } from "../components/GradientBackground";
import { colors, spacing } from "../theme/tokens";
import { useAuth } from "../context/AuthContext";
import { getDriverQuests } from "../services/api";
import { formatNumber } from "../i18n/i18n";
import { useT } from "../context/LanguageContext";
import { questState, questProgressPct, tripsLeft, timeLeftLabel, questRules, sortQuests } from "../utils/quests";

// ArrivoExpress quests: finish a number of real trips, earn a fixed reward.
// Text comes from i18n/translations.js.

const STATE_TAG = {
  active: { key: "tagActive", tone: "amber" },
  earned: { key: "tagEarned", tone: "teal" },
  paid: { key: "tagPaid", tone: "teal" },
  upcoming: { key: "tagUpcoming", tone: "amber" },
  full: { key: "tagFull", tone: "amber" },
  ended: { key: "tagEnded", tone: "amber" },
};

function QuestCard({ quest }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const state = questState(quest);
  const pct = questProgressPct(quest);
  const tag = STATE_TAG[state];
  const left = tripsLeft(quest);

  return (
    <Card tone="dark" style={{ marginBottom: spacing.sm }}>
      <View style={styles.headRow}>
        <View style={{ flex: 1, paddingRight: spacing.sm }}>
          <Text style={styles.questTitle}>{quest.title}</Text>
          <Text style={styles.meta}>
            {quest.tier ? t("tierTrips", { tier: quest.tier }) : t("anyTrip")} · {timeLeftLabel(quest.endsAt, new Date(), t)}
          </Text>
        </View>
        <View style={{ alignItems: "flex-end" }}>
          <Text style={styles.reward}>₦{formatNumber(quest.rewardNaira)}</Text>
          <Tag label={t(tag.key)} tone={tag.tone} />
        </View>
      </View>

      <View style={styles.barTrack} accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: pct }}>
        <View style={[styles.barFill, { width: `${pct}%` }]} />
      </View>
      <Text style={styles.progressText}>
        {state === "earned" || state === "paid"
          ? t("progressEarned")
          : state === "full"
            ? t("progressFull")
            : state === "ended"
              ? t("progressEnded", { done: quest.progress, target: quest.targetTrips })
              : left > 0
                ? t("progressActiveLeft", { done: quest.progress, target: quest.targetTrips, left })
                : t("progressActive", { done: quest.progress, target: quest.targetTrips })}
      </Text>

      <Text style={styles.rulesToggle} onPress={() => setOpen((v) => !v)} accessibilityRole="button">
        {open ? t("rulesHide") : t("rulesShow")}
      </Text>
      {open ? questRules(quest, t).map((r, i) => <Text key={i} style={styles.rule}>• {r}</Text>) : null}
    </Card>
  );
}

export default function QuestsScreen() {
  const { t } = useT();
  const insets = useSafeAreaInsets();
  const { token } = useAuth();
  const [quests, setQuests] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const { quests } = await getDriverQuests(token);
      setQuests(sortQuests(quests));
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  return (
    <View style={styles.screen}>
      <GradientBackground variant="dark" />
      <ScrollView
        contentContainerStyle={{ paddingTop: insets.top + spacing.lg, paddingHorizontal: spacing.lg, paddingBottom: 40 }}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={colors.amber} />}
      >
        <Text style={styles.title}>{t("questsTitle")}</Text>
        <Text style={styles.intro}>{t("questsIntro")}</Text>

        {loading && !quests ? <ActivityIndicator color={colors.amber} /> : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {quests && quests.length === 0 && !error ? (
          <Text style={styles.empty}>{t("questsEmpty")}</Text>
        ) : null}
        {(quests || []).map((q) => (
          <QuestCard key={q.id} quest={q} />
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.dark.bg0 },
  title: { fontSize: 19, fontWeight: "700", color: colors.dark.text, marginBottom: spacing.xs },
  intro: { color: colors.dark.textMuted, fontSize: 12, lineHeight: 17, marginBottom: spacing.md },
  headRow: { flexDirection: "row", alignItems: "flex-start", marginBottom: spacing.sm },
  questTitle: { color: colors.dark.text, fontSize: 14, fontWeight: "700" },
  meta: { color: colors.dark.textMuted, fontSize: 11, marginTop: 3, textTransform: "capitalize" },
  reward: { color: colors.amber, fontSize: 18, fontWeight: "800", marginBottom: 4 },
  barTrack: { height: 8, borderRadius: 4, backgroundColor: "rgba(255,255,255,0.12)", overflow: "hidden" },
  barFill: { height: 8, borderRadius: 4, backgroundColor: colors.amber },
  progressText: { color: colors.dark.text, fontSize: 12, marginTop: spacing.sm },
  rulesToggle: { color: colors.tealBright, fontSize: 12, fontWeight: "600", marginTop: spacing.sm },
  rule: { color: colors.dark.textMuted, fontSize: 11.5, lineHeight: 17, marginTop: 4 },
  error: { color: "#FF9B8A", fontSize: 12.5, marginBottom: spacing.md, textAlign: "center" },
  empty: { color: colors.dark.textMuted, fontSize: 13, textAlign: "center", marginTop: spacing.lg },
});
