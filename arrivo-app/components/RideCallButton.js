import React, { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { View, Text, Pressable, Modal, StyleSheet, ActivityIndicator, Linking, Animated, Easing, AccessibilityInfo } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useStreamVideoClient } from "@stream-io/video-react-native-sdk";
import { useAuth } from "../context/AuthContext";
import { startRideCall, reportCallEvent, requestCallSupport } from "../services/api";
import { PHASE, initialState, reduce, failureFromError, failureView, ringRemaining } from "../utils/callFlow";
import { colors, radius, spacing } from "../theme/tokens";

// The big call button. Rider and driver both use this one component; only the
// words change. No phone number is shown, sent or dialled anywhere. If the
// call cannot be made, the person gets a way out that always includes support.
//
//   <RideCallButton rideId={id} role="rider" counterpart="your driver" navigation={navigation} enabled={...} />
//
// `role` is "rider" or "driver". `enabled` is false until the ride is one that
// can be called (the server enforces this too).
// RideArrivo's own support chat. Only used when there is no call to attach a ticket to.
const SUPPORT_CHAT_FALLBACK = "https://wa.me/2348162706078";

export default function RideCallButton({ rideId, role, counterpart, navigation, enabled = true, compact = false, supportRoute = "Support" }) {
  const { token } = useAuth();
  const client = useStreamVideoClient();
  const [state, dispatch] = useReducer(reduce, undefined, initialState);
  const [remaining, setRemaining] = useState(45);
  const [supportMsg, setSupportMsg] = useState(null);
  const inFlight = useRef(false);        // blocks a second tap in the same instant, before React re-renders
  const activeCall = useRef(null);
  const subs = useRef([]);
  const startedAt = useRef(0);
  const sessionRef = useRef(null);
  const pulse = useRef(new Animated.Value(0)).current;

  const who = role === "rider" ? "driver" : "rider";
  const label = counterpart || (role === "rider" ? "your driver" : "your rider");

  useEffect(() => {
    let off = false;
    AccessibilityInfo.isReduceMotionEnabled().then((reduced) => {
      if (off || reduced) return;
      Animated.loop(
        Animated.sequence([
          Animated.timing(pulse, { toValue: 1, duration: 1400, easing: Easing.out(Easing.quad), useNativeDriver: true }),
          Animated.timing(pulse, { toValue: 0, duration: 0, useNativeDriver: true }),
        ])
      ).start();
    }).catch(() => {});
    return () => { off = true; pulse.stopAnimation(); };
  }, [pulse]);

  const cleanup = useCallback(() => {
    subs.current.forEach((fn) => { try { fn(); } catch (_) {} });
    subs.current = [];
  }, []);
  useEffect(() => () => { cleanup(); }, [cleanup]);

  const leaveQuietly = useCallback(async () => {
    const c = activeCall.current;
    activeCall.current = null;
    cleanup();
    if (c) { try { await c.leave(); } catch (_) {} }
  }, [cleanup]);

  const report = useCallback((event, reason) => {
    const id = sessionRef.current;
    if (id && token) reportCallEvent(token, id, event, reason).catch(() => {});
  }, [token]);

  const fail = useCallback((failure) => {
    inFlight.current = false;
    dispatch({ type: "FAILED", failure });
  }, []);

  const begin = useCallback(async (media = "audio") => {
    if (!enabled || inFlight.current) return;
    inFlight.current = true;
    dispatch({ type: "TAP" });
    setSupportMsg(null);
    try {
      if (!client) throw Object.assign(new Error("Calling isn't ready yet. Give it a moment."), { status: 503, code: "calling_unavailable" });
      dispatch({ type: "STARTING" });
      const res = await startRideCall(token, rideId, media);
      sessionRef.current = res.session.id;
      startedAt.current = Date.now();
      setRemaining(res.ringTimeoutSeconds || 45);
      dispatch({ type: "STARTED", session: res.session, ringTimeoutSeconds: res.ringTimeoutSeconds });

      const call = client.call(res.call.type, res.call.id);
      activeCall.current = call;
      try {
        await call.get();
        await call.join();
      } catch (joinErr) {
        // The server made the call but this phone could not get into it.
        report("failed", "join_error");
        throw Object.assign(new Error("We couldn't connect the call."), { status: 502, code: "call_failed", sessionId: res.session.id });
      }

      // Answered when the other person is in the call with us. Gone again after
      // that means they hung up. A "rejected" event means they said no.
      const sub1 = call.state.participants$.subscribe((ps) => {
        const n = Array.isArray(ps) ? ps.length : 0;
        if (n >= 2 && !call.__arrivoAnswered) { call.__arrivoAnswered = true; dispatch({ type: "CONNECTED" }); }
        else if (n < 2 && call.__arrivoAnswered) { dispatch({ type: "REMOTE_ENDED" }); leaveQuietly(); inFlight.current = false; }
      });
      const sub2 = call.state.callingState$.subscribe((s) => {
        if (s === "left" && call.__arrivoAnswered) { dispatch({ type: "HANGUP" }); cleanup(); inFlight.current = false; }
        if (s === "reconnecting-failed") { dispatch({ type: "DROPPED" }); leaveQuietly(); inFlight.current = false; }
      });
      const offRej = call.on("call.rejected", () => { dispatch({ type: "DECLINED" }); leaveQuietly(); inFlight.current = false; });
      subs.current.push(() => sub1.unsubscribe(), () => sub2.unsubscribe(), offRej);
    } catch (e) {
      sessionRef.current = sessionRef.current || (e && e.sessionId) || null;
      await leaveQuietly();
      if (!e || !e.status) report("failed", "start_error");
      fail(failureFromError(e));
    }
  }, [enabled, client, token, rideId, leaveQuietly, cleanup, report, fail]);

  // Count down while ringing. At zero the call is missed, and the person is
  // told clearly, rather than hearing ringing forever.
  useEffect(() => {
    if (state.phase !== PHASE.RINGING) return undefined;
    const t = setInterval(() => {
      const left = ringRemaining(startedAt.current, Date.now(), state.ringTimeoutSeconds);
      setRemaining(left);
      if (left <= 0) {
        report("missed", "ring_timeout");
        dispatch({ type: "RING_TIMEOUT" });
        leaveQuietly();
        inFlight.current = false;
      }
    }, 500);
    return () => clearInterval(t);
  }, [state.phase, state.ringTimeoutSeconds, leaveQuietly, report]);

  const cancel = async () => {
    report("cancelled");
    dispatch({ type: "CANCEL" });
    await leaveQuietly();
    inFlight.current = false;
  };

  const dismiss = () => { dispatch({ type: "DISMISS" }); setSupportMsg(null); inFlight.current = false; };

  const talkToSupport = async () => {
    if (state.supportBusy) return;
    dispatch({ type: "SUPPORT_BUSY" });
    try {
      const id = sessionRef.current;
      if (!id) {
        // Nothing was ever started (for example no connection or the ride is not
        // callable). The Support screen works without a call.
        dispatch({ type: "SUPPORT_FAILED" });
        dismiss();
        if (navigation && supportRoute) navigation.navigate(supportRoute, { rideId });
        else Linking.openURL(SUPPORT_CHAT_FALLBACK).catch(() => {});
        return;
      }
      const r = await requestCallSupport(token, id);
      dispatch({ type: "SUPPORT_DONE", ticketId: r.ticketId });
      setSupportMsg("Support has your ride and what happened. They'll reach you in the app shortly.");
    } catch (e) {
      dispatch({ type: "SUPPORT_FAILED" });
      // Last resort that still works with no session: the company's own line.
      const url = (e && e.support && e.support.whatsappUrl) || (state.failure && state.failure.support && state.failure.support.whatsappUrl) || null;
      setSupportMsg(url ? "We couldn't open a ticket from here. Opening the RideArrivo support chat." : "We couldn't reach support from here. Please open Support in the menu.");
      if (url) Linking.openURL(url).catch(() => {});
    }
  };

  const retry = () => { dismiss(); setTimeout(() => begin("audio"), 0); };
  const message = () => { dismiss(); if (navigation) navigation.navigate("Chat", { rideId }); };

  const busy = state.phase === PHASE.CHECKING || state.phase === PHASE.STARTING;
  const ringing = state.phase === PHASE.RINGING || busy;
  const view = state.phase === PHASE.FAILED ? failureView(state.failure, { counterpart: label, canChat: !!navigation }) : null;
  const scale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.18] });
  const fade = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.45, 0] });

  return (
    <View>
      <Pressable
        onPress={() => begin("audio")}
        disabled={!enabled || busy}
        accessibilityRole="button"
        accessibilityLabel={`Call ${label} in the app. No phone numbers are shared.`}
        accessibilityState={{ disabled: !enabled || busy, busy }}
        style={({ pressed }) => [styles.big, compact && styles.bigCompact, (!enabled) && styles.bigOff, pressed && { transform: [{ scale: 0.98 }] }]}
      >
        {enabled ? <Animated.View pointerEvents="none" style={[styles.halo, { transform: [{ scale }], opacity: fade }]} /> : null}
        <View style={styles.bigIcon}>
          {busy ? <ActivityIndicator color={colors.ink} /> : <Ionicons name="call" size={compact ? 22 : 28} color={colors.ink} />}
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.bigTitle}>{busy ? "Connecting…" : `Call ${label}`}</Text>
          <Text style={styles.bigSub}>{enabled ? "Free, in the app. Your number stays private." : `Opens once your ${who} is assigned`}</Text>
        </View>
        <Ionicons name="chevron-forward" size={20} color={colors.ink} />
      </Pressable>

      <View style={styles.row}>
        {navigation ? (
          <Pressable style={styles.link} onPress={() => navigation.navigate("Chat", { rideId })} accessibilityRole="button" accessibilityLabel={`Message ${label}`}>
            <Ionicons name="chatbubble-ellipses-outline" size={16} color={colors.dark.text} />
            <Text style={styles.linkText}>Message</Text>
          </Pressable>
        ) : null}
        {navigation && supportRoute ? (
          <Pressable
            style={styles.link}
            onPress={() => navigation.navigate(supportRoute, { rideId })}
            accessibilityRole="button"
            accessibilityLabel="Get help from RideArrivo support"
          >
            <Ionicons name="shield-checkmark-outline" size={16} color={colors.dark.text} />
            <Text style={styles.linkText}>Need help?</Text>
          </Pressable>
        ) : null}
      </View>

      <Modal visible={state.phase === PHASE.RINGING} transparent animationType="fade" onRequestClose={cancel}>
        <View style={styles.scrim}>
          <View style={styles.sheet} accessibilityViewIsModal>
            <View style={styles.ringIcon}><Ionicons name="call" size={36} color={colors.ink} /></View>
            <Text style={styles.sheetTitle} accessibilityLiveRegion="polite">Calling {label}…</Text>
            <Text style={styles.sheetBody}>Ringing in the app · {remaining}s</Text>
            <Pressable onPress={cancel} style={styles.cancel} accessibilityRole="button" accessibilityLabel="Cancel the call">
              <Ionicons name="close" size={20} color="#fff" />
              <Text style={styles.cancelText}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      <Modal visible={state.phase === PHASE.FAILED} transparent animationType="slide" onRequestClose={dismiss}>
        <View style={styles.scrim}>
          <View style={[styles.sheet, { alignItems: "stretch" }]} accessibilityViewIsModal>
            {view ? (
              <>
                <Text style={[styles.sheetTitle, { textAlign: "center" }]} accessibilityLiveRegion="assertive">{view.title}</Text>
                <Text style={[styles.sheetBody, { textAlign: "center" }]}>{view.body}</Text>
                {view.actions.includes("retry") ? (
                  <Pressable onPress={retry} style={styles.primary} accessibilityRole="button"><Ionicons name="refresh" size={18} color={colors.ink} /><Text style={styles.primaryText}>Try again</Text></Pressable>
                ) : null}
                {view.actions.includes("chat") ? (
                  <Pressable onPress={message} style={styles.secondary} accessibilityRole="button"><Ionicons name="chatbubble-ellipses-outline" size={18} color="#fff" /><Text style={styles.secondaryText}>Message in app</Text></Pressable>
                ) : null}
                {view.actions.includes("support") ? (
                  <Pressable onPress={talkToSupport} disabled={state.supportBusy || !!state.ticketId} style={[styles.support, !!state.ticketId && { opacity: 0.8 }]} accessibilityRole="button">
                    {state.supportBusy ? <ActivityIndicator color={colors.ink} /> : <Ionicons name={state.ticketId ? "checkmark-circle" : "headset"} size={18} color={colors.ink} />}
                    <Text style={styles.supportText}>{state.ticketId ? "Support has been told" : "Talk to Support"}</Text>
                  </Pressable>
                ) : null}
                <Text style={styles.care}>{supportMsg || view.reassurance}</Text>
                <Pressable onPress={dismiss} style={{ alignSelf: "center", padding: spacing.sm }} accessibilityRole="button"><Text style={styles.close}>Close</Text></Pressable>
              </>
            ) : null}
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  big: { flexDirection: "row", alignItems: "center", gap: spacing.md, backgroundColor: colors.amber, borderRadius: radius.lg, paddingVertical: 18, paddingHorizontal: spacing.md, minHeight: 76, shadowColor: colors.amber, shadowOpacity: 0.45, shadowRadius: 18, shadowOffset: { width: 0, height: 6 }, elevation: 8, overflow: "visible" },
  bigCompact: { minHeight: 64, paddingVertical: 12 },
  bigOff: { backgroundColor: "rgba(244,163,0,0.35)", shadowOpacity: 0, elevation: 0 },
  halo: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0, borderRadius: radius.lg, backgroundColor: colors.amber },
  bigIcon: { width: 48, height: 48, borderRadius: 24, backgroundColor: "rgba(255,255,255,0.55)", alignItems: "center", justifyContent: "center" },
  bigTitle: { color: colors.ink, fontSize: 19, fontWeight: "800" },
  bigSub: { color: colors.ink, opacity: 0.8, fontSize: 12.5, marginTop: 2 },
  row: { flexDirection: "row", justifyContent: "center", gap: spacing.lg, marginTop: spacing.sm },
  link: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 10, paddingHorizontal: 8, minHeight: 44 },
  linkText: { color: colors.dark.text, fontSize: 14, fontWeight: "600" },
  scrim: { flex: 1, backgroundColor: "rgba(8,8,30,0.72)", justifyContent: "flex-end" },
  sheet: { backgroundColor: colors.ink, borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: spacing.lg, paddingBottom: 36, alignItems: "center", gap: spacing.sm },
  ringIcon: { width: 84, height: 84, borderRadius: 42, backgroundColor: colors.amber, alignItems: "center", justifyContent: "center", marginBottom: spacing.xs },
  sheetTitle: { color: "#fff", fontSize: 22, fontWeight: "800" },
  sheetBody: { color: "rgba(255,255,255,0.75)", fontSize: 15, lineHeight: 21 },
  cancel: { marginTop: spacing.md, flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: colors.coral, borderRadius: radius.pill, paddingVertical: 14, paddingHorizontal: 34, minHeight: 52 },
  cancelText: { color: "#fff", fontSize: 17, fontWeight: "700" },
  primary: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, backgroundColor: colors.amber, borderRadius: radius.pill, paddingVertical: 15, minHeight: 52, marginTop: spacing.sm },
  primaryText: { color: colors.ink, fontSize: 17, fontWeight: "800" },
  secondary: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, borderWidth: 1.5, borderColor: "rgba(255,255,255,0.4)", borderRadius: radius.pill, paddingVertical: 14, minHeight: 52 },
  secondaryText: { color: "#fff", fontSize: 16, fontWeight: "700" },
  support: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, backgroundColor: "#fff", borderRadius: radius.pill, paddingVertical: 15, minHeight: 52 },
  supportText: { color: colors.ink, fontSize: 17, fontWeight: "800" },
  care: { color: "rgba(255,255,255,0.8)", fontSize: 13.5, textAlign: "center", marginTop: spacing.xs, lineHeight: 19 },
  close: { color: "rgba(255,255,255,0.6)", fontSize: 14, textDecorationLine: "underline" },
});
