import React, { useCallback, useEffect, useRef, useState } from "react";
import { View, Text, Modal, StyleSheet } from "react-native";
import * as Location from "expo-location";
import { Button } from "./UI";
import { colors, spacing, radius } from "../theme/tokens";
import { useAuth } from "../context/AuthContext";
import { sendWelfarePing, answerWelfare } from "../services/api";
import { WELFARE_PING_MS, shouldWatch, secondsLeft, clock, pingBody } from "../utils/welfare";

// While a trip is in progress, tell the server where the rider is every 30
// seconds. If the server decides the rider has been still for too long it asks
// "Are you safe?" and this shows the question. Yes carries on; No, or no
// answer in two minutes, alerts the RideArrivo team. Works the same for
// RideArrivo, ArrivoExpress and ArrivoChauffeur trips.
//
// It never blocks the trip: if location is off or the network drops, it stays
// quiet. A silent phone is handled by the server, which alerts on its own when
// a question goes unanswered.
export default function WelfareCheck({ rideId, rideStatus }) {
  const { token } = useAuth();
  const [deadline, setDeadline] = useState(null);
  const [now, setNow] = useState(Date.now());
  const [sending, setSending] = useState(false);
  const [alerted, setAlerted] = useState(false);
  const allowed = useRef(null);

  const ping = useCallback(async () => {
    try {
      if (allowed.current === null) {
        let { status } = await Location.getForegroundPermissionsAsync();
        if (status === "undetermined") ({ status } = await Location.requestForegroundPermissionsAsync());
        allowed.current = status === "granted";
      }
      if (!allowed.current) return;
      const body = pingBody(await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }));
      if (!body) return;
      const r = await sendWelfarePing(token, rideId, body);
      if (r.raised) { setAlerted(true); setDeadline(null); }
      else if (r.ask) setDeadline((d) => d || Date.now() + (r.answerWithinSeconds ?? 120) * 1000);
      else setDeadline(null);
    } catch (e) {
      // Never get in the way of the trip over this.
    }
  }, [token, rideId]);

  useEffect(() => {
    if (!shouldWatch(rideStatus)) { setDeadline(null); return undefined; }
    ping();
    const id = setInterval(ping, WELFARE_PING_MS);
    return () => clearInterval(id);
  }, [rideStatus, ping]);

  useEffect(() => {
    if (!deadline) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [deadline]);

  const answer = async (safe) => {
    setSending(true);
    try {
      const r = await answerWelfare(token, rideId, safe);
      setDeadline(null);
      if (!safe || r.raised) setAlerted(true);
    } catch (e) {
      // Leave the question up so they can try again.
    } finally { setSending(false); }
  };

  const left = secondsLeft(deadline, now);
  return (
    <>
      <Modal visible={!!deadline && !alerted} transparent animationType="fade" onRequestClose={() => {}}>
        <View style={styles.backdrop}>
          <View style={styles.sheet} accessibilityViewIsModal>
            <Text style={styles.title}>Are you safe?</Text>
            <Text style={styles.body}>You have not moved for a while. Tell us you are okay, or we will alert the RideArrivo team.</Text>
            <Text style={styles.timer}>{clock(left)}</Text>
            <Button label="Yes, I am safe" onPress={() => answer(true)} disabled={sending} />
            <View style={{ height: spacing.sm }} />
            <Button label="No, I need help" variant="ghost" onPress={() => answer(false)} disabled={sending} />
          </View>
        </View>
      </Modal>
      <Modal visible={alerted} transparent animationType="fade" onRequestClose={() => setAlerted(false)}>
        <View style={styles.backdrop}>
          <View style={styles.sheet}>
            <Text style={styles.title}>We have alerted the team</Text>
            <Text style={styles.body}>The RideArrivo team has been told and will try to reach you. If you are in danger, call the emergency number now.</Text>
            <Button label="Okay" onPress={() => setAlerted(false)} />
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(18,18,59,0.55)", justifyContent: "center", padding: spacing.lg },
  sheet: { backgroundColor: "#FFFFFF", borderRadius: radius.lg, padding: spacing.lg },
  title: { fontSize: 22, fontWeight: "800", color: colors.ink, textAlign: "center" },
  body: { fontSize: 14.5, lineHeight: 21, color: colors.textMuted, textAlign: "center", marginTop: spacing.sm, marginBottom: spacing.md },
  timer: { fontSize: 34, fontWeight: "800", color: colors.ink, textAlign: "center", marginBottom: spacing.md },
});
