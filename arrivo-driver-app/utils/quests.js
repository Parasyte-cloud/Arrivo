// Pure helpers for the Quests screen: no imports, so a plain node test can
// load this file (same approach as privacyPolicy.js).

// What a quest card should say, from the API's quest row.
//   state: "earned" | "paid" | "full" | "ended" | "upcoming" | "active"
export function questState(q, now = new Date()) {
  if (q.paid) return "paid";
  if (q.earned) return "earned";
  if (new Date(q.endsAt) < now) return "ended";
  if (new Date(q.startsAt) > now) return "upcoming";
  if (q.quotaFull) return "full";
  return "active";
}

export function questProgressPct(q) {
  const target = Number(q.targetTrips) || 0;
  if (target <= 0) return 0;
  const done = q.earned ? target : Math.min(Number(q.progress) || 0, target);
  return Math.round((done / target) * 100);
}

export function tripsLeft(q) {
  return Math.max((Number(q.targetTrips) || 0) - (Number(q.progress) || 0), 0);
}

// "2 days left", "5 h left", "Ended". t is the app's translate function.
export function timeLeftLabel(endsAt, now = new Date(), t) {
  const ms = new Date(endsAt).getTime() - now.getTime();
  if (ms <= 0) return t("timeEnded");
  const hours = Math.floor(ms / 3600000);
  if (hours >= 48) return t("timeDays", { n: Math.floor(hours / 24) });
  if (hours >= 1) return t("timeHours", { n: hours });
  return t("timeMin", { n: Math.max(Math.floor(ms / 60000), 1) });
}

// The rules a driver should be able to read before chasing a quest.
export function questRules(q, t) {
  const rules = [];
  rules.push(q.tier ? t("ruleFinishTier", { target: q.targetTrips, tier: q.tier }) : t("ruleFinish", { target: q.targetTrips }));
  rules.push(t("ruleTrip", { km: Number(q.minTripKm), min: Number(q.minTripMinutes) }));
  rules.push(t("ruleRider", { n: q.maxTripsPerRider }));
  if (q.minDriverRating) rules.push(t("ruleRating", { rating: Number(q.minDriverRating) }));
  rules.push(t("ruleLimited"));
  return rules;
}

// Quests worth showing first: ones you can still earn, then earned, then the rest.
export function sortQuests(quests, now = new Date()) {
  const rank = { active: 0, earned: 1, paid: 2, upcoming: 3, full: 4, ended: 5 };
  return [...quests].sort((a, b) => {
    const r = rank[questState(a, now)] - rank[questState(b, now)];
    return r !== 0 ? r : new Date(a.endsAt) - new Date(b.endsAt);
  });
}
