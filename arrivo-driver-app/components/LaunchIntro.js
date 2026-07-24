import React, { useEffect, useRef } from "react";
import { View, Animated, StyleSheet } from "react-native";
import { colors } from "../theme/tokens";

// A brief, one-time brand moment played on cold launch, right after the
// native splash screen (see app.json's expo-splash-screen config, same
// cream background as here so the handoff is seamless) hides and before the
// real first screen (Login or the main tabs, decided by App.js) appears.
//
// Kept deliberately simple, per the actual product ask: the pin settles in
// with a soft drop, a single thin motion streak sweeps in from behind it and
// fades right as it arrives — echoing the road-swoosh already baked into
// the icon artwork itself, as if that motion is what's carrying the pin
// in — then the wordmark fades in underneath. No new dependency: built
// entirely on React Native's built-in Animated API, same as every other
// animated screen in this app.
export default function LaunchIntro({ onFinish }) {
  const pinOpacity = useRef(new Animated.Value(0)).current;
  const pinScale = useRef(new Animated.Value(0.86)).current;
  const pinTranslateY = useRef(new Animated.Value(-16)).current;
  const streakOpacity = useRef(new Animated.Value(0)).current;
  const streakOffset = useRef(new Animated.Value(1)).current; // 1 = starting position, 0 = merged into the pin
  const wordmarkOpacity = useRef(new Animated.Value(0)).current;
  const wordmarkTranslateY = useRef(new Animated.Value(8)).current;

  useEffect(() => {
    const anim = Animated.parallel([
      // The streak: fades in, slides toward the pin, then fades out right
      // as it "arrives" — a quick self-contained sequence running inside
      // the outer parallel so its timing stays independent of the pin's.
      Animated.sequence([
        Animated.parallel([
          Animated.timing(streakOpacity, { toValue: 0.6, duration: 160, useNativeDriver: true }),
          Animated.timing(streakOffset, { toValue: 0, duration: 380, useNativeDriver: true }),
        ]),
        Animated.timing(streakOpacity, { toValue: 0, duration: 220, useNativeDriver: true }),
      ]),
      // The pin: fades in and drops into place with a soft spring settle,
      // starting a beat after the streak begins its approach.
      Animated.timing(pinOpacity, { toValue: 1, duration: 300, delay: 70, useNativeDriver: true }),
      Animated.spring(pinScale, { toValue: 1, delay: 70, friction: 6, tension: 55, useNativeDriver: true }),
      Animated.spring(pinTranslateY, { toValue: 0, delay: 70, friction: 7, tension: 50, useNativeDriver: true }),
      // The wordmark: only once the pin's had a moment to settle.
      Animated.timing(wordmarkOpacity, { toValue: 1, duration: 300, delay: 620, useNativeDriver: true }),
      Animated.timing(wordmarkTranslateY, { toValue: 0, duration: 300, delay: 620, useNativeDriver: true }),
    ]);

    anim.start(() => {
      // A short hold once everything's settled — long enough to actually
      // register as a moment, not so long it reads as a delay.
      setTimeout(() => onFinish && onFinish(), 260);
    });

    return () => anim.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const streakTranslateX = streakOffset.interpolate({ inputRange: [0, 1], outputRange: [0, -70] });
  const streakTranslateY = streakOffset.interpolate({ inputRange: [0, 1], outputRange: [0, 50] });

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
        />
        <Animated.Image
          source={require("../assets/icon.png")}
          style={[styles.pin, { opacity: pinOpacity, transform: [{ scale: pinScale }, { translateY: pinTranslateY }] }]}
        />
      </View>
      <Animated.Image
        source={require("../assets/wordmark.png")}
        style={[styles.brand, { opacity: wordmarkOpacity, transform: [{ translateY: wordmarkTranslateY }] }]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.cream, alignItems: "center", justifyContent: "center" },
  pinWrap: { width: 120, height: 120, alignItems: "center", justifyContent: "center" },
  pin: { width: 120, height: 120, resizeMode: "contain" },
  streak: {
    position: "absolute",
    width: 46,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.amber,
  },
  // Real wordmark image (1829x309 source, ~5.92:1) instead of a system-font
  // rendering of the two-tone "RideArrivo" text — matches the actual
  // logotype used on the website and elsewhere now, rather than an
  // approximation in whatever font this device has installed.
  brand: { width: 220, height: 220 / (1829 / 309), marginTop: 18, resizeMode: "contain" },
});
