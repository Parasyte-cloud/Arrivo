import React, { useState } from "react";
import { View, Text, StyleSheet, ScrollView, Image } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as ImagePicker from "expo-image-picker";
import { Card, Button } from "../components/UI";
import { GradientBackground } from "../components/GradientBackground";
import { colors, spacing, radius } from "../theme/tokens";
import { useAuth } from "../context/AuthContext";

// Same 6MB cap as the backend (routes/auth.js MAX_ID_DOCUMENT_BYTES) — an
// ID photo needs to stay legible, so this is looser than the 4MB avatar cap.
const MAX_ID_DOCUMENT_BYTES = 6 * 1024 * 1024;

// Real ID verification — this used to be a "Verified ID" label on Profile
// with no upload, no status, and nothing behind it at all (tapping it did
// nothing). Now a rider can actually submit a photo of their ID here, see
// its real review status, and resubmit if it's rejected.
export default function VerifyIdScreen() {
  const insets = useSafeAreaInsets();
  const { user, submitIdVerification } = useAuth();
  const [pickedUri, setPickedUri] = useState(null);
  const [pickedDataUrl, setPickedDataUrl] = useState(null);
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [justSubmitted, setJustSubmitted] = useState(false);

  const status = user?.id_verification_status || "unverified";

  const pickIdPhoto = async (fromCamera) => {
    setError(null);
    setJustSubmitted(false);
    const permission = fromCamera
      ? await ImagePicker.requestCameraPermissionsAsync()
      : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      setError(fromCamera ? "Please allow camera access to photograph your ID." : "Please allow photo access to choose your ID photo.");
      return;
    }
    const launch = fromCamera ? ImagePicker.launchCameraAsync : ImagePicker.launchImageLibraryAsync;
    const result = await launch({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      quality: 0.8,
      base64: true,
    });
    if (result.canceled || !result.assets || !result.assets[0]) return;
    const asset = result.assets[0];

    if (asset.fileSize && asset.fileSize > MAX_ID_DOCUMENT_BYTES) {
      setError("Please choose a photo smaller than 6MB.");
      return;
    }
    if (!asset.base64) {
      setError("Couldn't read that photo. Please try another.");
      return;
    }
    setPickedUri(asset.uri);
    setPickedDataUrl(`data:${asset.mimeType || "image/jpeg"};base64,${asset.base64}`);
  };

  const submit = async () => {
    if (!pickedDataUrl) return;
    setSubmitting(true);
    setError(null);
    try {
      await submitIdVerification(pickedDataUrl);
      setPickedUri(null);
      setPickedDataUrl(null);
      setJustSubmitted(true);
    } catch (e) {
      setError(e.message || "Couldn't submit your ID right now. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <View style={styles.screen}>
      <GradientBackground variant="dark" />
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + spacing.lg, paddingHorizontal: spacing.lg, paddingBottom: 40 }}>
        <Text style={styles.title}>Verified ID</Text>

        {status === "verified" ? (
          <Card tone="dark" style={{ marginBottom: spacing.md, borderColor: "#8FD9C4", borderWidth: 1 }}>
            <Text style={styles.statusHeading}>✅ Your ID is verified</Text>
            <Text style={styles.meta}>
              Thanks for confirming your identity. There's nothing else to do here.
            </Text>
          </Card>
        ) : status === "pending" ? (
          <Card tone="dark" style={{ marginBottom: spacing.md, borderColor: colors.amber, borderWidth: 1 }}>
            <Text style={styles.statusHeading}>⏳ Under review</Text>
            <Text style={styles.meta}>
              We've received your ID and a team member will review it shortly. This usually doesn't take long — you don't need to do anything else right now.
            </Text>
          </Card>
        ) : (
          <>
            {status === "rejected" ? (
              <Card tone="dark" style={{ marginBottom: spacing.md, borderColor: colors.coral, borderWidth: 1 }}>
                <Text style={[styles.statusHeading, { color: colors.coral }]}>Verification rejected</Text>
                <Text style={styles.meta}>
                  {user?.id_verification_rejection_reason || "Your last submission couldn't be verified."} Please take or choose a new, clear photo of a valid ID and resubmit below.
                </Text>
              </Card>
            ) : (
              <Card tone="dark" style={{ marginBottom: spacing.md }}>
                <Text style={styles.meta}>
                  Verifying your ID helps keep every trip safer for riders and drivers alike. Take a clear photo of a
                  valid government ID (passport, driver's license, or national ID) — make sure your name and photo are
                  visible and not blurry.
                </Text>
              </Card>
            )}

            {justSubmitted ? (
              <Card tone="dark" style={{ marginBottom: spacing.md, borderColor: colors.amber, borderWidth: 1 }}>
                <Text style={styles.statusHeading}>Submitted</Text>
                <Text style={styles.meta}>Your ID is now pending review.</Text>
              </Card>
            ) : null}

            <Card tone="dark" style={{ marginBottom: spacing.md }}>
              <Text style={styles.cardLabel}>Your ID photo</Text>
              {pickedUri ? (
                <Image source={{ uri: pickedUri }} style={styles.preview} />
              ) : (
                <View style={styles.previewPlaceholder}>
                  <Text style={styles.meta}>No photo selected yet</Text>
                </View>
              )}
              <View style={{ height: spacing.sm }} />
              <Button label="Take a photo" onPress={() => pickIdPhoto(true)} variant="ghost" tone="dark" />
              <View style={{ height: spacing.sm }} />
              <Button label="Choose from library" onPress={() => pickIdPhoto(false)} variant="ghost" tone="dark" />
              {error ? <Text style={styles.errorText}>{error}</Text> : null}
            </Card>

            <Button
              label={submitting ? "Submitting…" : "Submit for review"}
              onPress={submit}
              disabled={!pickedDataUrl || submitting}
              variant="primary"
            />
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.dark.bg0 },
  title: { fontSize: 19, fontWeight: "700", color: colors.dark.text, marginBottom: spacing.md },
  cardLabel: { color: colors.dark.text, fontWeight: "600", fontSize: 12, marginBottom: 10 },
  statusHeading: { color: colors.dark.text, fontWeight: "700", fontSize: 15, marginBottom: 6 },
  meta: { color: colors.dark.textMuted, fontSize: 12.5, lineHeight: 18 },
  errorText: { color: "#FF9B8A", fontSize: 11.5, marginTop: 8 },
  preview: { width: "100%", height: 200, borderRadius: radius.md, marginBottom: 4 },
  previewPlaceholder: {
    width: "100%", height: 140, borderRadius: radius.md, marginBottom: 4,
    alignItems: "center", justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.04)", borderWidth: 1, borderColor: colors.dark.hairline, borderStyle: "dashed",
  },
});
