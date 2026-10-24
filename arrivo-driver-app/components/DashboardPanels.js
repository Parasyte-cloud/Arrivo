import React from "react";
import { ActivityIndicator, Image, StyleSheet, Text, View } from "react-native";
import { Card, Button, Tag } from "./UI";
import { colors, spacing } from "../theme/tokens";
import { dayLabel, inspectionView, naira, subscriptionView, tripsLabel } from "../tiers/dashboard";
import { SERVICE_TIERS, dueLabel, formatNaira, headcount, jobStatusLabel, nextStep, optionName } from "../tiers/jobs";

const RED = "#FF9B8A";
const RED_BG = "rgba(225,82,61,0.18)";
const RED_BORDER = "#E1523D";

// Who the driver is and how today is going: name, vehicle, trips and earnings.
export function ProfileStatsCard({ profile, today }) {
  if (!profile) return null;
  const initial = (profile.name || "D").trim().charAt(0).toUpperCase();
  const car = profile.vehicle ? [profile.vehicle.makeModel, profile.vehicle.plateNumber].filter(Boolean).join(" · ") : "";
  return (
    <Card tone="dark" style={{ marginBottom: spacing.md }}>
      <View style={styles.profileRow}>
        {profile.photoUrl ? (
          <Image source={{ uri: profile.photoUrl }} style={styles.avatar} accessibilityLabel="Your profile photo" />
        ) : (
          <View style={[styles.avatar, styles.avatarFallback]}>
            <Text style={styles.avatarText}>{initial}</Text>
          </View>
        )}
        <View style={{ flex: 1 }}>
          <Text style={styles.name} numberOfLines={1}>{profile.name}</Text>
          {car ? <Text style={styles.meta} numberOfLines={1}>{car}</Text> : null}
          {!profile.isVerified ? <Text style={styles.pending}>Waiting for approval</Text> : null}
        </View>
        {profile.rating ? <Tag label={`★ ${Number(profile.rating).toFixed(1)}`} tone="amber" /> : null}
      </View>
      <View style={styles.statsRow} accessibilityLabel="Today">
        <View style={styles.stat}>
          <Text style={styles.statValue}>{today ? today.trips : 0}</Text>
          <Text style={styles.statLabel}>{today && today.trips === 1 ? "trip today" : "trips today"}</Text>
        </View>
        <View style={styles.divider} />
        <View style={styles.stat}>
          <Text style={styles.statValue}>{naira(today ? today.earningsNaira : 0)}</Text>
          <Text style={styles.statLabel}>earned today</Text>
        </View>
      </View>
    </Card>
  );
}

// The red quarterly inspection reminder. Shows nothing until 7 days before it is due.
export function InspectionBanner({ inspection }) {
  const view = inspectionView(inspection);
  if (!view) return null;
  return (
    <View style={styles.redCard} accessibilityRole="alert">
      <Text style={styles.redTitle}>{view.title}</Text>
      <Text style={styles.redBody}>{view.detail}</Text>
      {view.dueOn ? <Text style={styles.redMeta}>Due {dayLabel(view.dueOn)}</Text> : null}
    </View>
  );
}

// Subscribed or not, and the one button to fix it.
export function SubscriptionCard({ subscription, now, paying, onSubscribe }) {
  const view = subscriptionView(subscription, now);
  if (view.state === "unknown" || view.state === "free") return null;
  const red = view.tone === "red";
  return (
    <View style={[red ? styles.redCard : styles.okCard]} accessibilityRole={red ? "alert" : "text"}>
      <Text style={red ? styles.redTitle : styles.okTitle}>{view.title}</Text>
      <Text style={red ? styles.redBody : styles.okBody}>{view.detail}</Text>
      {view.button ? (
        <View style={{ marginTop: spacing.md }}>
          {paying ? <ActivityIndicator color={colors.amber} /> : <Button label={view.button} onPress={onSubscribe} trailingIcon />}
        </View>
      ) : null}
    </View>
  );
}

// A job our team assigned: an ArrivoAir flight, an ArrivoBoat trip or an
// ArrivoRemovals move. One button, forward only.
export function ServiceJobCard({ job, busy, disabled, onAdvance }) {
  const tier = SERVICE_TIERS[job.tier];
  const step = nextStep(job);
  const who = headcount(job);
  return (
    <Card tone="dark" style={{ marginBottom: spacing.sm }}>
      <View style={styles.rowBetween}>
        <Tag label={tier ? tier.label : "Job"} tone="amber" />
        <Tag label={jobStatusLabel(job.status)} tone={job.status === "in_progress" ? "amber" : "teal"} />
      </View>
      <Text style={styles.jobTitle}>{job.pickupAddress}</Text>
      <Text style={styles.meta}>To {job.destinationAddress}</Text>
      <Text style={styles.jobWhen}>{dueLabel(job.requestedAt)}</Text>
      <Text style={styles.meta}>
        {[optionName(job.tier, job.option), who, `Rider: ${job.riderFirstName}`].filter(Boolean).join(" · ")}
      </Text>
      {job.details ? <Text style={styles.meta}>Notes: {job.details}</Text> : null}
      {job.fareNaira != null ? <Text style={styles.fare}>{formatNaira(job.fareNaira)}</Text> : null}
      {step ? (
        <View style={{ marginTop: spacing.sm }}>
          {busy ? <ActivityIndicator color={colors.amber} /> : <Button label={step.label} onPress={() => onAdvance(job, step.to)} disabled={disabled} trailingIcon />}
        </View>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  profileRow: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  avatar: { width: 52, height: 52, borderRadius: 26 },
  avatarFallback: { backgroundColor: "rgba(244,163,0,0.2)", alignItems: "center", justifyContent: "center" },
  avatarText: { color: colors.amber, fontSize: 22, fontWeight: "800" },
  name: { color: colors.dark.text, fontSize: 16, fontWeight: "800" },
  meta: { color: colors.dark.textMuted, fontSize: 11.5, marginTop: 4 },
  pending: { color: colors.amber, fontSize: 11.5, fontWeight: "700", marginTop: 4 },
  statsRow: { flexDirection: "row", alignItems: "center", marginTop: spacing.md, paddingTop: spacing.md, borderTopWidth: 1, borderTopColor: "rgba(255,255,255,0.1)" },
  stat: { flex: 1, alignItems: "center" },
  statValue: { color: colors.dark.text, fontSize: 22, fontWeight: "800" },
  statLabel: { color: colors.dark.textMuted, fontSize: 11.5, marginTop: 2 },
  divider: { width: 1, height: 34, backgroundColor: "rgba(255,255,255,0.1)" },
  redCard: { backgroundColor: RED_BG, borderColor: RED_BORDER, borderWidth: 1.5, borderRadius: 16, padding: spacing.md, marginBottom: spacing.md },
  redTitle: { color: RED, fontSize: 15, fontWeight: "800" },
  redBody: { color: colors.dark.text, fontSize: 13, lineHeight: 19, marginTop: 4 },
  redMeta: { color: RED, fontSize: 12, fontWeight: "700", marginTop: 6 },
  okCard: { backgroundColor: "rgba(46,160,110,0.14)", borderColor: "rgba(46,160,110,0.5)", borderWidth: 1, borderRadius: 16, padding: spacing.md, marginBottom: spacing.md },
  okTitle: { color: colors.dark.text, fontSize: 14, fontWeight: "800" },
  okBody: { color: colors.dark.textMuted, fontSize: 12.5, marginTop: 2 },
  rowBetween: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" },
  jobTitle: { color: colors.dark.text, fontSize: 14, fontWeight: "700", marginTop: 6 },
  jobWhen: { color: colors.amber, fontSize: 12, fontWeight: "700", marginTop: 4 },
  fare: { color: colors.amber, fontSize: 15, fontWeight: "700", marginTop: 6 },
});
