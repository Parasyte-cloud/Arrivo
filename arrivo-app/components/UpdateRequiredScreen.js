import React from "react";
import { View, Text, StyleSheet, Linking, Platform } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "./UI";
import { colors, spacing } from "../theme/tokens";
import { appVersion } from "../services/clientInfo";

// Full-screen stop shown when the backend says this build is too old to keep
// working with. There is deliberately no way past it: the next request would
// only be refused again. The one button goes to the store page the backend
// named (or tells the rider to open the store themselves when there is none).
export default function UpdateRequiredScreen({ info }) {
  const open = () => {
    if (info.storeUrl) Linking.openURL(info.storeUrl).catch(() => {});
  };
  const storeName = Platform.OS === "ios" ? "the App Store" : "Google Play";
  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.body}>
        <Text style={styles.title}>Please update RideArrivo</Text>
        <Text style={styles.text}>{info.message}</Text>
        <Text style={styles.small}>
          {info.minVersion ? `You need version ${info.minVersion} or newer.` : ""}
          {appVersion() ? ` You have ${appVersion()}.` : ""}
        </Text>
        {info.storeUrl ? (
          <Button label={`Update on ${storeName}`} variant="primary" style={{ marginTop: spacing.lg }} onPress={open} />
        ) : (
          <Text style={[styles.text, { marginTop: spacing.lg }]}>Open {storeName}, search for RideArrivo and tap Update.</Text>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.ink },
  body: { flex: 1, justifyContent: "center", padding: spacing.lg },
  title: { color: "#fff", fontSize: 22, fontWeight: "700", marginBottom: spacing.sm },
  text: { color: "rgba(255,255,255,0.85)", fontSize: 15, lineHeight: 22 },
  small: { color: "rgba(255,255,255,0.6)", fontSize: 12.5, marginTop: spacing.sm },
});
