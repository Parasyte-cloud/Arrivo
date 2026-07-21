import React, { useRef, useState } from "react";
import { View, Text, StyleSheet, ActivityIndicator, Pressable } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { Button } from "../components/UI";
import { colors, spacing, radius } from "../theme/tokens";
import { useAuth } from "../context/AuthContext";
import { scanRideQr } from "../services/api";

// The driver's printed placard QR encodes a URL like
// https://ridearrivo.com/scan.html?token=XXXX — we only need the token,
// scanned and submitted straight from the app instead of routing through
// that web page, since the app already has an authenticated session.
function extractScanToken(data) {
  const match = String(data || "").match(/[?&]token=([^&]+)/);
  if (match) return decodeURIComponent(match[1]);
  // Fall back to treating the whole scanned value as the token, in case
  // a placard is ever printed with just the raw token instead of a URL.
  return String(data || "").trim() || null;
}

export default function ScanScreen({ navigation }) {
  const { token } = useAuth();
  const [permission, requestPermission] = useCameraPermissions();
  const [status, setStatus] = useState("idle"); // idle | verifying | error
  const [message, setMessage] = useState(null);
  const scannedRef = useRef(false);

  const handleScan = async ({ data }) => {
    if (scannedRef.current) return; // ignore repeat callbacks while we're already processing one
    scannedRef.current = true;
    setStatus("verifying");
    setMessage(null);

    const scanToken = extractScanToken(data);
    if (!scanToken) {
      setStatus("error");
      setMessage("That QR code doesn't look like a RideArrivo driver placard.");
      scannedRef.current = false;
      return;
    }

    try {
      const { ride } = await scanRideQr(token, scanToken);
      navigation.replace("Tracking", { rideId: ride.id });
    } catch (e) {
      setStatus("error");
      setMessage(e.message || "Couldn't confirm this ride. Please try again.");
      scannedRef.current = false;
    }
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
        {status === "error" && message ? (
          <View style={styles.statusBox}>
            <Text style={styles.errorText}>{message}</Text>
            <View style={{ flexDirection: "row", gap: 10, marginTop: 10 }}>
              {isTopUpError ? (
                <Pressable
                  onPress={() => navigation.navigate("Home", { screen: "Wallet" })}
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
  statusText: { color: "#fff", fontSize: 13, marginTop: 8 },
  errorText: { color: "#FF9B8A", fontSize: 13, textAlign: "center" },
  retryBtn: { marginTop: 10, paddingVertical: 8, paddingHorizontal: 16, backgroundColor: colors.amber, borderRadius: radius.pill },
  retryText: { color: colors.ink, fontWeight: "700", fontSize: 12.5 },
});
