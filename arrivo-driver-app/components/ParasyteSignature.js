import React, { useEffect, useRef } from "react";
import { Animated, Easing, Linking, Pressable, StyleSheet, Text, View } from "react-native";

// The PArAsYtE signature: a metallic silver wordmark, centred alone at the
// base of the screen, linking to parasyte.cloud, with a slow gentle swell.
// The P is drawn larger so it reads as the P of the mark, and "arasyte"
// follows it, so the word reads Parasyte and not a doubled P.
//
// To use the real P logo, add it as assets/parasyte-p.png and pass
// logo={require("../assets/parasyte-p.png")} to show it in place of the drawn P.
export const PARASYTE_URL = "https://www.parasyte.cloud";

const SILVER = "#C9CED6";
const SILVER_DARK = "#8A919C";

export default function ParasyteSignature({ style, logo, light = false }) {
  const swell = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(swell, { toValue: 1, duration: 2600, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(swell, { toValue: 0, duration: 2600, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [swell]);

  const scale = swell.interpolate({ inputRange: [0, 1], outputRange: [1, 1.05] });
  const opacity = swell.interpolate({ inputRange: [0, 1], outputRange: [0.72, 1] });
  const mainColor = light ? SILVER_DARK : SILVER;

  return (
    <View style={[styles.wrap, style]}>
      <Pressable
        onPress={() => Linking.openURL(PARASYTE_URL).catch(() => {})}
        accessibilityRole="link"
        accessibilityLabel="PArAsYtE, opens parasyte.cloud"
        hitSlop={12}
      >
        <Animated.View style={[styles.row, { transform: [{ scale }], opacity }]}>
          {logo ? (
            <Animated.Image source={logo} style={styles.logo} resizeMode="contain" />
          ) : (
            <Text style={[styles.p, { color: mainColor }]}>P</Text>
          )}
          <Text style={[styles.rest, { color: mainColor }]}>arasyte</Text>
        </Animated.View>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: "center", justifyContent: "center", paddingVertical: 28 },
  row: { flexDirection: "row", alignItems: "baseline" },
  p: {
    fontSize: 24,
    fontWeight: "800",
    letterSpacing: 1,
    textShadowColor: "rgba(255,255,255,0.35)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  rest: {
    fontSize: 17,
    fontWeight: "600",
    letterSpacing: 2,
    textShadowColor: "rgba(255,255,255,0.3)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  logo: { width: 22, height: 26, marginRight: 1, alignSelf: "center" },
});
