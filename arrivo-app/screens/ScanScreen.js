import React, { useRef, useState } from "react";
import { View, Text, StyleSheet, ActivityIndicator, Pressable } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { Button } from "../components/UI";
import { colors, spacing, radius } from "../theme/tokens";
import { useAuth } from "../context/AuthContext";
import { scanRideQr, isNetworkError } from "../services/api";
import { getCachedActiveRide, queuePendingScan } from "../services/rideCache";

// The driver's printed placard QR encodes a URL like
// https://ridearrivo.com/scan.html?token=XXXX&name=...&vehicle=...&plate=...
// — the token is what the backend actually trusts, but name/vehicle/plate
// ride along in the same URL purely so this screen can show "this is your
// driver" instantly with zero network call, which matters a lot for a
// traveler scanning with no signal yet. Parsed with plain regexes (not
// URLSearchParams) to match the existing token-extraction approach and
// avoid depending on a Web API that may not be polyfilled in this RN runtime.
function parseScanPayload(data) {
  const str = String(data || "");
  const field = (key) => {
    const match = str.match(new RegExp("[?&]" + key + "=([^&]+)"));
    return match ? decodeURIComponent(match[1]) : null;
  };
  const token = field("token") || (!/^https?:\/\//i.test(str) ? str.trim() : null) || null;
  return {
    scanToken: token,
    driverName: field("name"),
    vehicle: field("vehicle"),
    plate: field("plate"),
  };
}

// Loose, offline-only sanity check: if we have a cached ride AND both sides
// name a driver, they should agree — this can't replace the backend's real
// rider+driver match (see POST /api/rides/scan), but it stops an obviously
// wrong placard from being confirmed while there's no server to ask.
function driverInfoConflicts(cachedRide, scanned) {
  if (!cachedRide || !cachedRide.driverName || !scanned.driverName) return false;
  return cachedRide.driverName.trim().toLowerCase() !== scanned.driverName.trim().toLowerCase();
}

export default function ScanScreen({ navigation }) {
  const { token } = useAuth();
  const [permission, requestPermission] = useCameraPermissions();
  const [status, setStatus] = useState("idle"); // idle | verifying | error | offline-no-cache
  const [message, setMessage] = useState(null);
  const [offlineDriverInfo, setOfflineDriverInfo] = useState(null);
  const scannedRef = useRef(false);
  const lastScanTokenRef = useRef(null);

  const confirmScan = async (scanToken, driverInfo) => {
    try {
      const { ride } = await scanRideQr(token, scanToken);
      navigation.replace("Tracking", { rideId: ride.id });
      return;
    } catch (e) {
      if (!isNetworkError(e)) {
        setStatus("error");
        setMessage(e.message || "Couldn't confirm this ride. Please try again.");
        scannedRef.current = false;
        return;
      }
      // Genuine connectivity failure — fall back to whatever we already
      // know locally instead of a dead-end error.
      const cached = await getCachedActiveRide();
      if (cached && !driverInfoConflicts(cached, driverInfo)) {
        await queuePendingScan(scanToken, cached.id);
        navigation.replace("Tracking", {
          rideId: cached.id,
          offlinePending: true,
          offlineDriverInfo: driverInfo,
          offlineRideSummary: cached,
        });
        return;
      }
      if (cached && driverInfoConflicts(cached, driverInfo)) {
        setStatus("error");
        setMessage(
          `No internet connection, and this doesn't look like your assigned driver (expected ${cached.driverName}). Please connect to WiFi to confirm, or check you're scanning the right placard.`
        );
        scannedRef.current = false;
        return;
      }
      // No cache to fall back on at all — still show what the QR itself
      // says, and let them retry once they have a connection.
      setStatus("offline-no-cache");
      setOfflineDriverInfo(driverInfo);
      scannedRef.current = false;
    }
  };

  const handleScan = async ({ data }) => {
    if (scannedRef.current) return; // ignore repeat callbacks while we're already processing one
    scannedRef.current = true;
    setStatus("verifying");
    setMessage(null);

    const parsed = parseScanPayload(data);
    if (!parsed.scanToken) {
      setStatus("error");
      setMessage("That QR code doesn't look like a RideArrivo driver placard.");
      scannedRef.current = false;
      return;
    }

    lastScanTokenRef.current = parsed;
    await confirmScan(parsed.scanToken, { name: parsed.driverName, vehicle: parsed.vehicle, plate: parsed.plate });
  };

  const retryOffline = async () => {
    if (!lastScanTokenRef.current) return;
    setStatus("verifying");
    setMessage(null);
    const parsed = lastScanTokenRef.current;
    await confirmScan(parsed.scanToken, { name: parsed.driverName, vehicle: parsed.vehicle, plate: parsed.plate });
  };

  // "Reserve, pay at pickup" rides get charged from the wallet right at
  // scan time (see POST /api/rides/scan) — if the balance can't cover it,
  // the backend's error message mentions "top up" explicitly, which is
  // what this checks for to offer a direct link instead of just "try again."
  const isTopUpError = !!message && /top up/i.test(message);

  if (!permission) {
    return (
      <View style={styles.screen}>
        <ActivityIndicator color={colors.amber} size="large" />
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <View style={[styles.screen, { padding: spacing.lg }]}>
        <Text style={styles.permissionText}>
          RideArrivo needs camera access to scan your driver's QR code and start live tracking.
        </Text>
        <View style={{ height: spacing.md }} />
        <Button label="Allow camera access" onPress={requestPermission} trailingIcon />
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onBarcodeScanned={status === "verifying" ? undefined : handleScan}
      />
      <View style={styles.overlay}>
        <View style={styles.frame} />
        <Text style={styles.hint}>Point your camera at the QR code on your driver's placard</Text>
        {status === "verifying" ? (
          <View style={styles.statusBox}>
            <ActivityIndicator color="#fff" />
            <Text style={styles.statusText}>Confirming your ride…</Text>
          </View>
        ) : null}
        {status === "offline-no-cache" && offlineDriverInfo ? (
          <View style={styles.statusBox}>
            <Text style={styles.offlineTitle}>📡 No internet connection</Text>
            {offlineDriverInfo.name ? (
              <Text style={styles.offlineDriver}>
                Your driver: {offlineDriverInfo.name}
                {offlineDriverInfo.vehicle ? ` · ${offlineDriverInfo.vehicle}` : ""}
                {offlineDriverInfo.plate ? ` · Plate ${offlineDriverInfo.plate}` : ""}
              </Text>
            ) : null}
            <Text style={styles.statusText}>
              Connect to WiFi (airport WiFi works fine — no SIM data needed) and tap Retry to confirm your ride and
              start live tracking.
            </Text>
            <Pressable onPress={retryOffline} style={[styles.retryBtn, { marginTop: 10 }]}>
              <Text style={styles.retryText}>Retry</Text>
            </Pressable>
          </View>
        ) : null}
        {status === "error" && message ? (
          <View style={styles.statusBox}>
            <Text style={styles.errorText}>{message}</Text>
            <View style={{ flexDirection: "row", gap: 10, marginTop: 10 }}>
              {isTopUpError ? (
                <Pressable
                  // Wallet is a sibling top-level Tab.Screen, not nested
                  // inside Home — see the identical fix in
                  // CheckoutScreen.js's "Top up wallet" button.
                  onPress={() => navigation.navigate("Wallet")}
                  style={styles.retryBtn}
                >
                  <Text style={styles.retryText}>Top up wallet</Text>
                </Pressable>
              ) : null}
              <Pressable
                onPress={() => {
                  setStatus("idle");
                  setMessage(null);
                }}
                style={[styles.retryBtn, isTopUpError && { backgroundColor: "transparent", borderWidth: 1, borderColor: colors.amber }]}
              >
                <Text style={[styles.retryText, isTopUpError && { color: colors.amber }]}>
                  {isTopUpError ? "Scan again" : "Try again"}
                </Text>
              </Pressable>
            </View>
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.ink, alignItems: "center", justifyContent: "center" },
  permissionText: { color: colors.dark.text, fontSize: 14, textAlign: "center", lineHeight: 20 },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.15)",
  },
  frame: {
    width: 240,
    height: 240,
    borderRadius: radius.md,
    borderWidth: 3,
    borderColor: colors.amber,
  },
  hint: {
    color: "#fff",
    fontSize: 13,
    textAlign: "center",
    marginTop: spacing.lg,
    paddingHorizontal: spacing.xl || 40,
  },
  statusBox: {
    position: "absolute",
    bottom: 60,
    left: spacing.lg,
    right: spacing.lg,
    backgroundColor: "rgba(12,12,46,0.9)",
    borderRadius: radius.md,
    padding: spacing.md,
    alignItems: "center",
  },
  statusText: { color: "#fff", fontSize: 13, marginTop: 8, textAlign: "center" },
  offlineTitle: { color: colors.amber, fontSize: 13.5, fontWeight: "700" },
  offlineDriver: { color: "#fff", fontSize: 13, marginTop: 6, textAlign: "center", fontWeight: "600" },
  errorText: { color: "#FF9B8A", fontSize: 13, textAlign: "center" },
  retryBtn: { marginTop: 10, paddingVertical: 8, paddingHorizontal: 16, backgroundColor: colors.amber, borderRadius: radius.pill },
  retryText: { color: colors.ink, fontWeight: "700", fontSize: 12.5 },
});
