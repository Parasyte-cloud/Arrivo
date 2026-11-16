import React, { useCallback, useState } from "react";
import { View, Text, Pressable, ScrollView, StyleSheet, KeyboardAvoidingView, Platform, ActivityIndicator, useWindowDimensions } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Location from "expo-location";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { LiveMap } from "./LiveMap";
import AddressAutocomplete from "./AddressAutocomplete";
import ParasyteSignature from "./ParasyteSignature";
import { colors, radius, spacing } from "../theme/tokens";
import { useAuth } from "../context/AuthContext";
import { getReverseGeocode } from "../services/api";

// The map-first layout ArrivoExpress and ArrivoCampus open with, the same as the web: a full-screen map, a floating
// bar with the tier name, and a bottom sheet over the map holding "Where to?". The screen decides what goes in the sheet.

export function MapFirst({ title, subtitle, onBack, pickup, destination, driverLocation, heading, live, children }) {
  const insets = useSafeAreaInsets();
  const win = useWindowDimensions();
  const [sheetH, setSheetH] = useState(Math.round(win.height * 0.45));
  const onLayout = useCallback((e) => setSheetH(Math.round(e.nativeEvent.layout.height)), []);
  const lat = (p) => (p && p.lat != null ? { lat: p.lat, lng: p.lng } : null);
  return (
    <View style={styles.root}>
      <LiveMap fill pickup={lat(pickup)} destination={lat(destination)} driverLocation={driverLocation} heading={heading} live={live}
        bottomInset={sheetH} topInset={insets.top + 56} />
      <View pointerEvents="box-none" style={[styles.topWrap, { top: insets.top + 8 }]}>
        <View style={styles.topBar}>
          {onBack ? (
            <Pressable onPress={onBack} style={styles.back} accessibilityRole="button" accessibilityLabel="Back" hitSlop={8}>
              <Ionicons name="chevron-back" size={20} color={colors.ink} />
            </Pressable>
          ) : null}
          <View style={{ flexShrink: 1 }}>
            <Text style={styles.topTitle} numberOfLines={1}>{title}</Text>
            {subtitle ? <Text style={styles.topSub} numberOfLines={1}>{subtitle}</Text> : null}
          </View>
        </View>
      </View>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.sheetWrap} pointerEvents="box-none">
        <View style={[styles.sheet, { maxHeight: Math.round(win.height * 0.68) }]} onLayout={onLayout}>
          <View style={styles.handle} />
          <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: spacing.md, paddingBottom: Math.max(insets.bottom, 8) }}>
            {children}
            <ParasyteSignature />
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

// Round pickup dot, dashed line, square destination, and the locate and swap buttons on the right, like the web.
export function RouteFields({ pickup, destination, onPickupText, onPickupSelect, onDestinationText, onDestinationSelect, onSwap, onLocate, locating, pickupPlaceholder, destinationPlaceholder, pickupLabel, destinationLabel }) {
  return (
    <View style={styles.routeCard}>
      <View style={styles.rail}>
        <View style={styles.dot} />
        <View style={styles.railLine} />
        <View style={styles.square} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.fieldLabel}>{pickupLabel}</Text>
        <AddressAutocomplete bare value={pickup} onChangeText={onPickupText} onSelect={onPickupSelect} placeholder={pickupPlaceholder} inputStyle={styles.fieldInput} />
        <View style={styles.divider} />
        <Text style={styles.fieldLabel}>{destinationLabel}</Text>
        <AddressAutocomplete bare value={destination} onChangeText={onDestinationText} onSelect={onDestinationSelect} placeholder={destinationPlaceholder} inputStyle={styles.fieldInput} />
      </View>
      <View style={styles.sideButtons}>
        <Pressable onPress={onLocate} style={styles.roundBtn} accessibilityRole="button" accessibilityLabel="Use my location" hitSlop={6}>
          {locating ? <ActivityIndicator size="small" color={colors.primary} /> : <Ionicons name="locate" size={20} color={colors.primary} />}
        </Pressable>
        <Pressable onPress={onSwap} style={styles.roundBtn} accessibilityRole="button" accessibilityLabel="Swap pickup and destination" hitSlop={6}>
          <Ionicons name="swap-vertical" size={20} color={colors.ink} />
        </Pressable>
      </View>
    </View>
  );
}

// "Ride now | Schedule", "Going to school | Coming home".
export function Segmented({ options, value, onChange }) {
  return (
    <View style={styles.seg}>
      {options.map((o) => {
        const on = o.key === value;
        return (
          <Pressable key={o.key} onPress={() => onChange(o.key)} style={[styles.segItem, on && styles.segOn]} accessibilityRole="button" accessibilityState={{ selected: on }}>
            <Text style={[styles.segText, on && styles.segTextOn]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// A sideways row of pills (the vehicle choice, the school gates).
export function ChipRow({ chips, activeKey, onPress, busyKey }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 8, paddingVertical: 2 }} style={{ marginTop: spacing.sm }}>
      {chips.map((c) => {
        const on = c.key === activeKey;
        return (
          <Pressable key={c.key} onPress={() => onPress(c)} style={[styles.chip, on && styles.chipOn]} accessibilityRole="button" accessibilityState={{ selected: on }}>
            {busyKey === c.key ? <ActivityIndicator size="small" color={colors.amber} /> : null}
            <Text style={[styles.chipText, on && styles.chipTextOn]}>{c.label}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

// "Use my location": an explicit ask, never run on open. Same steps and messages as the Route screen.
export function useMyLocation(onPlace) {
  const { t } = useTranslation();
  const { token } = useAuth();
  const [locating, setLocating] = useState(false);
  const [locationError, setLocationError] = useState("");
  const locate = useCallback(async () => {
    setLocationError("");
    setLocating(true);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") { setLocationError(t("route.locationPermissionDeniedYouCan")); return; }
      let position;
      try {
        position = await Promise.race([
          Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
          new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 12000)),
        ]);
      } catch (e) { setLocationError(t("route.couldnTGetAGps")); return; }
      try {
        const r = await getReverseGeocode(token, position.coords.latitude, position.coords.longitude);
        onPlace({ address: r.address, lat: r.lat, lng: r.lng });
      } catch (e) { setLocationError(t("route.gotYourLocationButCouldn")); }
    } finally { setLocating(false); }
  }, [token, t, onPlace]);
  return { locate, locating, locationError };
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  topWrap: { position: "absolute", left: 12, right: 12 },
  topBar: { flexDirection: "row", alignItems: "center", gap: 10, alignSelf: "flex-start", maxWidth: "100%", paddingVertical: 8, paddingHorizontal: 10, borderRadius: 999, backgroundColor: colors.sheet, borderWidth: 1, borderColor: colors.line, shadowColor: "#000", shadowOpacity: 0.16, shadowRadius: 10, shadowOffset: { width: 0, height: 3 }, elevation: 4 },
  back: { width: 34, height: 34, borderRadius: 17, alignItems: "center", justifyContent: "center", backgroundColor: colors.fieldBg },
  topTitle: { color: colors.ink, fontSize: 16, fontWeight: "800" },
  topSub: { color: colors.textMuted, fontSize: 11, fontWeight: "700", letterSpacing: 0.5, textTransform: "uppercase" },
  sheetWrap: { position: "absolute", left: 0, right: 0, bottom: 0 },
  sheet: { backgroundColor: colors.sheet, borderTopLeftRadius: 28, borderTopRightRadius: 28, paddingTop: 8, shadowColor: "#000", shadowOpacity: 0.18, shadowRadius: 16, shadowOffset: { width: 0, height: -4 }, elevation: 10 },
  handle: { alignSelf: "center", width: 44, height: 5, borderRadius: 3, backgroundColor: colors.lineStrong, marginBottom: 10 },
  routeCard: { flexDirection: "row", alignItems: "center", gap: 10, padding: 14, borderRadius: 22, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line },
  rail: { alignItems: "center", width: 22 },
  dot: { width: 14, height: 14, borderRadius: 7, backgroundColor: colors.primary },
  railLine: { width: 0, height: 34, borderLeftWidth: 2, borderStyle: "dashed", borderColor: colors.lineStrong, marginVertical: 3 },
  square: { width: 14, height: 14, borderRadius: 3, backgroundColor: colors.ink },
  fieldLabel: { color: colors.textMuted, fontSize: 10.5, fontWeight: "800", letterSpacing: 1 },
  fieldInput: { fontSize: 16, fontWeight: "600", paddingVertical: 4, color: colors.ink },
  divider: { height: 1, backgroundColor: colors.line, marginVertical: 6 },
  sideButtons: { gap: 8 },
  roundBtn: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center", backgroundColor: colors.sheet, borderWidth: 1, borderColor: colors.line },
  seg: { flexDirection: "row", padding: 4, borderRadius: 16, backgroundColor: colors.fieldBg, marginTop: spacing.md },
  segItem: { flex: 1, alignItems: "center", paddingVertical: 12, borderRadius: 13 },
  segOn: { backgroundColor: colors.sheet, shadowColor: "#000", shadowOpacity: 0.1, shadowRadius: 5, shadowOffset: { width: 0, height: 2 }, elevation: 2 },
  segText: { color: colors.textMuted, fontSize: 15, fontWeight: "800" },
  segTextOn: { color: colors.ink },
  chip: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 999, backgroundColor: colors.sheet, borderWidth: 1, borderColor: colors.lineStrong },
  chipOn: { borderColor: colors.amber, backgroundColor: colors.fieldBg },
  chipText: { color: colors.ink, fontSize: 14, fontWeight: "700" },
  chipTextOn: { color: colors.ink },
});
