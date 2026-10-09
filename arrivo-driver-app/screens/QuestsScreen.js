import React, { useCallback, useState } from "react";
import { View, Text, StyleSheet, ScrollView, ActivityIndicator, RefreshControl } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect } from "@react-navigation/native";
import { Card, Tag } from "../components/UI";
import { GradientBackground } from "../components/GradientBackground";
import { colors, spacing } from "../theme/tokens";
import { useAuth } from "../context/AuthContext";
import { getDriverQuests } from "../services/api";
import { questState, questProgressPct, tripsLeft, timeLeftLabel, questRules, sortQuests } from "../utils/quests";

// ArrivoExpress quests: finish a number of real trips, earn a fixed reward.
// Text is English inline, like the rest of this app.

const STATE_TAG = {
  active: { label: "In progress", tone: "amber" },
  earned: { label: "Earned", tone: "teal" },
  paid: { label: "Paid to wallet", tone: "teal" },
  upcoming: { label: "Starts soon", tone: "amber" },
  full: { label: "All places taken", tone: "amber" },
  ended: { label: "Ended", tone: "amber" },
};

function QuestCard({ quest }) {
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
            {quest.tier ? `${quest.tier} trips` : "Any ArrivoExpress trip"} · {timeLeftLabel(quest.endsAt)}
          </Text>
        </View>
        <View style={{ alignItems: "flex-end" }}>
          <Text style={styles.reward}>₦{Number(quest.rewardNaira).toLocaleString()}</Text>
          <Tag label={tag.label} tone={tag.tone} />
        </View>
      </View>

      <View style={styles.barTrack} accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: pct }}>
        <View style={[styles.barFill, { width: `${pct}%` }]} />
      </View>
      <Text style={styles.progressText}>
        {state === "earned" || state === "paid"
          ? "Reward earned. It is paid into your wallet."
          : state === "full"
            ? "The reward places for this quest have all been taken."
            : state === "ended"
              ? `You finished ${quest.progress} of ${quest.targetTrips} trips.`
              : `${quest.progress} of ${quest.targetTrips} trips done${left > 0 ? `, ${left} to go` : ""}`}
      </Text>

      <Text style={styles.rulesToggle} onPress={() => setOpen((v) => !v)} accessibilityRole="button">
        {open ? "Hide the rules" : "See the rules"}
      </Text>
      {open ? questRules(quest).map((r, i) => <Text key={i} style={styles.rule}>• {r}</Text>) : null}
    </Card>
  );
}

export default function QuestsScreen() {
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
        <Text style={styles.title}>Quests</Text>
        <Text style={styles.intro}>Finish real trips, earn a fixed reward. Only trips that were started and ran their full length count.</Text>

        {loading && !quests ? <ActivityIndicator color={colors.amber} /> : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {quests && quests.length === 0 && !error ? (
          <Text style={styles.empty}>No quests are running right now. Check back soon.</Text>
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
