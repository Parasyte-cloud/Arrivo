import React, { useEffect, useRef } from "react";
import { Animated, Easing, Linking, Pressable, StyleSheet, View } from "react-native";

// The PArAsYtE signature: centered alone at the base of the screen, a metallic silver
// wordmark (P then "arasyte"), a gentle swell, opens parasyte.cloud.
export default function ParasyteSignature() {
  const swell = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(swell, { toValue: 1, duration: 2600, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      Animated.timing(swell, { toValue: 0, duration: 2600, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [swell]);
  const scale = swell.interpolate({ inputRange: [0, 1], outputRange: [1, 1.05] });
  return (
    <View style={styles.wrap}>
      <Pressable accessibilityRole="link" accessibilityLabel="PArAsYtE" onPress={() => Linking.openURL("https://www.parasyte.cloud").catch(() => {})} hitSlop={12}>
        <Animated.Text style={[styles.mark, { transform: [{ scale }] }]}>
          <Animated.Text style={styles.p}>P</Animated.Text>arasyte
        </Animated.Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: "center", paddingTop: 28, paddingBottom: 12 },
  mark: { fontSize: 15, letterSpacing: 3, color: "#8A8F99", fontWeight: "600", textShadowColor: "rgba(255,255,255,0.9)", textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 0 },
  p: { fontSize: 19, fontWeight: "800", color: "#6F7580" },
});
