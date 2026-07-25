import React, { useEffect, useRef } from "react";
import { View, Animated, StyleSheet, Platform, Easing } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { colors } from "../theme/tokens";

// A brief, one-time brand moment played on cold launch, right after the
// native splash screen (see app.json's expo-splash-screen config) hides and
// before the real first screen (Login or the main tabs, decided by App.js)
// appears.
//
// Android's native splash is intentionally inverted from iOS's (amber
// background, navy pin — see app.json's expo-splash-screen "android"
// override) purely per product ask; this screen has to match whichever one
// just handed off to it, or there'd be a jarring flash between the two. The
// navy-background/amber-pin assets below (icon.png, wordmark.png) are used
// on iOS; the amber-background/navy-pin assets (adaptive-icon-android.png,
// wordmark-android.png — same artwork, colors swapped) are used on Android.
// adaptive-icon-android.png specifically (not icon.png) is used for the pin
// on Android because it's transparent with no baked-in square background,
// so it drops cleanly onto this screen's amber fill with no visible edge —
// icon.png has navy baked into its corners, which would show as an ugly
// navy square floating on amber.
//
// Uber-style reveal: a soft motion streak sweeps in and "delivers" the pin,
// which fades and scales up with a single smooth ease-out (no spring or
// overshoot), then the wordmark fades up underneath once everything's
// settled. The streak is a LinearGradient (transparent -> accent ->
// transparent) rather than a flat-opacity rectangle — that's what keeps it
// reading as a clean, soft light trail instead of a hard-edged smudge. No
// new dependency beyond expo-linear-gradient, already used elsewhere in
// this app.
const EASE_OUT = Easing.out(Easing.cubic);
const STREAK_COLOR = Platform.OS === "android" ? colors.ink : colors.amber;

export default function LaunchIntro({ onFinish }) {
  const pinOpacity = useRef(new Animated.Value(0)).current;
  const pinScale = useRef(new Animated.Value(0.92)).current;
  const streakOpacity = useRef(new Animated.Value(0)).current;
  const streakOffset = useRef(new Animated.Value(1)).current; // 1 = starting position, 0 = merged into the pin
  const wordmarkOpacity = useRef(new Animated.Value(0)).current;
  const wordmarkTranslateY = useRef(new Animated.Value(10)).current;

  useEffect(() => {
    const anim = Animated.parallel([
      // The streak: fades in and glides toward the pin, then fades out
      // right as it "arrives" — a slow, deliberate sweep, not a flick.
      Animated.sequence([
        Animated.parallel([
          Animated.timing(streakOpacity, { toValue: 0.6, duration: 260, easing: EASE_OUT, useNativeDriver: true }),
          Animated.timing(streakOffset, { toValue: 0, duration: 760, easing: EASE_OUT, useNativeDriver: true }),
        ]),
        Animated.timing(streakOpacity, { toValue: 0, duration: 360, easing: EASE_OUT, useNativeDriver: true }),
      ]),
      // The pin: a single clean fade + scale-up, no bounce or overshoot —
      // Animated.timing with an ease-out curve reads as smooth and
      // deliberate rather than springy or jittery. Starts a beat after the
      // streak begins its approach.
      Animated.timing(pinOpacity, { toValue: 1, duration: 1250, delay: 90, easing: EASE_OUT, useNativeDriver: true }),
      Animated.timing(pinScale, { toValue: 1, duration: 1250, delay: 90, easing: EASE_OUT, useNativeDriver: true }),
      // The wordmark: fades and drifts up gently, starting only once the
      // pin has had a full moment to settle — nothing competes for
      // attention at the same time.
      Animated.timing(wordmarkOpacity, { toValue: 1, duration: 820, delay: 1400, easing: EASE_OUT, useNativeDriver: true }),
      Animated.timing(wordmarkTranslateY, { toValue: 0, duration: 820, delay: 1400, easing: EASE_OUT, useNativeDriver: true }),
    ]);

    anim.start(() => {
      // A held beat once everything's settled — long enough to actually
      // register as a moment, not so long it reads as a delay.
      setTimeout(() => onFinish && onFinish(), 700);
    });

    return () => anim.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const streakTranslateX = streakOffset.interpolate({ inputRange: [0, 1], outputRange: [0, -80] });
  const streakTranslateY = streakOffset.interpolate({ inputRange: [0, 1], outputRange: [0, 58] });

  return (
    <View style={styles.screen}>
      <View style={styles.pinWrap}>
        <Animated.View
          style={[
            styles.streak,
            {
              opacity: streakOpacity,
              transform: [{ translateX: streakTranslateX }, { translateY: streakTranslateY }, { rotate: "-28deg" }],
            },
          ]}
        >
          <LinearGradient
            colors={["transparent", STREAK_COLOR, "transparent"]}
            start={{ x: 0, y: 0.5 }}
            end={{ x: 1, y: 0.5 }}
            style={styles.streakGradient}
          />
        </Animated.View>
        <Animated.Image
          source={Platform.OS === "android" ? require("../assets/adaptive-icon-android.png") : require("../assets/icon.png")}
          style={[styles.pin, { opacity: pinOpacity, transform: [{ scale: pinScale }] }]}
        />
      </View>
      <Animated.Image
        source={Platform.OS === "android" ? require("../assets/wordmark-android.png") : require("../assets/wordmark.png")}
        style={[styles.brand, { opacity: wordmarkOpacity, transform: [{ translateY: wordmarkTranslateY }] }]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: Platform.OS === "android" ? colors.amber : colors.ink, alignItems: "center", justifyContent: "center" },
  pinWrap: { width: 120, height: 120, alignItems: "center", justifyContent: "center" },
  pin: { width: 120, height: 120, resizeMode: "contain" },
  // A gradient-filled capsule rather than a flat-color rectangle — the soft
  // transparent-to-color-to-transparent taper on both ends is what makes
  // this read as a clean light trail instead of a hard-edged smudge.
  // overflow: hidden clips the gradient to the rounded capsule shape.
  streak: {
    position: "absolute",
    width: 90,
    height: 5,
    borderRadius: 999,
    overflow: "hidden",
  },
  streakGradient: { flex: 1 },
  // Real wordmark image (1829x309 source, ~5.92:1) instead of a system-font
  // rendering of the two-tone "RideArrivo" text — matches the actual
  // logotype used on the website and elsewhere now, rather than an
  // approximation in whatever font this device has installed.
  brand: { width: 220, height: 220 / (1829 / 309), marginTop: 18, resizeMode: "contain" },
});
