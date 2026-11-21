import React, { useEffect, useRef } from "react";
import { Animated, Easing, Image, Linking, Pressable, StyleSheet, View } from "react-native";

// The PArAsYtE signature: the metallic silver wordmark (the P logo forms the P, "arasyte"
// follows), centered alone at the base of the screen, with a gentle swell. Opens parasyte.cloud.
export default function ParasyteSignature() {
  const swell = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(swell, { toValue: 1, duration: 2800, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      Animated.timing(swell, { toValue: 0, duration: 2800, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [swell]);
  const scale = swell.interpolate({ inputRange: [0, 1], outputRange: [1, 1.06] });
  return (
    <View style={styles.wrap}>
      <Pressable accessibilityRole="link" accessibilityLabel="PArAsYtE" onPress={() => Linking.openURL("https://www.parasyte.cloud").catch(() => {})} hitSlop={14}>
        <Animated.View style={{ transform: [{ scale }] }}>
          <Image source={require("../assets/parasyte-wordmark.png")} style={styles.img} resizeMode="contain" />
        </Animated.View>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: "center", paddingTop: 28, paddingBottom: 14 },
  img: { width: 120, height: 120 / (720 / 133) },
});
