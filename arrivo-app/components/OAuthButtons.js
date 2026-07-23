import React, { useEffect } from "react";
import { View, Text, Pressable, StyleSheet, Platform, ActivityIndicator } from "react-native";
import Constants from "expo-constants";
import * as WebBrowser from "expo-web-browser";
import * as Google from "expo-auth-session/providers/google";
import * as AppleAuthentication from "expo-apple-authentication";
import { colors, spacing } from "../theme/tokens";

// Needed once, at module load, so the in-app browser sheet Google sign-in
// opens actually closes itself and hands control back to the app when the
// redirect comes in — without this the browser can be left open after a
// successful sign-in.
WebBrowser.maybeCompleteAuthSession();

// Client IDs come from app.json's extra.googleOAuth (see app.json + the
// setup notes in the README this ships with) — created in Google Cloud
// Console, one OAuth client per platform. Never hardcoded here since these
// differ between the rider and driver app's own Google Cloud projects.
const GOOGLE_IOS_CLIENT_ID = Constants.expoConfig?.extra?.googleOAuth?.iosClientId;
const GOOGLE_ANDROID_CLIENT_ID = Constants.expoConfig?.extra?.googleOAuth?.androidClientId;
const GOOGLE_WEB_CLIENT_ID = Constants.expoConfig?.extra?.googleOAuth?.webClientId;

// Renders "Continue with Google" (both platforms) and "Sign in with Apple"
// (iOS only, per Apple's own button — Android has no Apple button at all).
// `disabled` is how the signup screen gates these behind the data-protection
// checkbox, exactly like the "Create account" button below it is gated by
// the same flag — nobody creates a RideArrivo profile any way, including via
// Google/Apple, without agreeing to the same terms.
export default function OAuthButtons({ onGoogleIdToken, onGoogleError, onAppleResult, disabled, busy }) {
  const googleConfigured = !!(GOOGLE_IOS_CLIENT_ID || GOOGLE_ANDROID_CLIENT_ID || GOOGLE_WEB_CLIENT_ID);

  const [request, response, promptAsync] = Google.useAuthRequest({
    iosClientId: GOOGLE_IOS_CLIENT_ID,
    androidClientId: GOOGLE_ANDROID_CLIENT_ID,
    webClientId: GOOGLE_WEB_CLIENT_ID,
    // openid+email+profile is enough for account creation — RideArrivo
    // never needs any broader Google scope (contacts, calendar, etc.).
    scopes: ["openid", "profile", "email"],
  });

  useEffect(() => {
    if (!response) return;
    // Previously only handled "success" and silently dropped everything
    // else — a real Google sign-in failure (bad client config, network
    // error) left the person with zero feedback: no error text, spinner
    // just stops, nothing happens. "dismiss"/"cancel" (they backed out of
    // the picker themselves) is intentionally still silent here, matching
    // how the Apple handler below ignores ERR_REQUEST_CANCELED — only a
    // genuine "error" type is worth surfacing.
    if (response.type === "error") {
      onGoogleError && onGoogleError(response.error?.message || "Couldn't sign in with Google. Please try again.");
      return;
    }
    if (response.type !== "success") return;
    // Different Expo/expo-auth-session versions have surfaced the Google ID
    // token in slightly different places over time — checking both keeps
    // this working regardless of exactly which one this project resolved to.
    const idToken = response.authentication?.idToken || response.params?.id_token;
    if (idToken) {
      onGoogleIdToken(idToken);
    } else {
      onGoogleError && onGoogleError("Couldn't complete Google sign-in. Please try again.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [response]);

  const handleAppleSignIn = async () => {
    try {
      const credential = await AppleAuthentication.signInAsync({
        requestedScopes: [
          AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
          AppleAuthentication.AppleAuthenticationScope.EMAIL,
        ],
      });
      // fullName is only ever populated on the very first authorization —
      // the caller has to send it to the backend right now, since Apple
      // never hands it over again on later sign-ins.
      onAppleResult({ identityToken: credential.identityToken, fullName: credential.fullName });
    } catch (e) {
      if (e.code === "ERR_REQUEST_CANCELED") return; // person just backed out — not an error
      onAppleResult({ error: e.message || "Apple sign-in failed. Please try again." });
    }
  };

  return (
    <View style={{ gap: 10 }}>
      {busy ? (
        <View style={{ alignItems: "center", paddingVertical: spacing.sm }}>
          <ActivityIndicator color={colors.tealBright} />
        </View>
      ) : (
        <>
          {googleConfigured ? (
            <Pressable
              disabled={disabled || !request}
              onPress={() => promptAsync()}
              style={[styles.button, styles.googleButton, (disabled || !request) && styles.buttonDisabled]}
            >
              <Text style={styles.googleG}>G</Text>
              <Text style={styles.buttonText}>Continue with Google</Text>
            </Pressable>
          ) : null}

          {Platform.OS === "ios" ? (
            <AppleAuthentication.AppleAuthenticationButton
              buttonType={AppleAuthentication.AppleAuthenticationButtonType.CONTINUE}
              buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.BLACK}
              cornerRadius={12}
              style={[styles.appleButton, disabled && styles.buttonDisabled]}
              onPress={disabled ? undefined : handleAppleSignIn}
            />
          ) : null}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  button: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    paddingVertical: 13,
    borderRadius: 12,
  },
  buttonDisabled: { opacity: 0.45 },
  googleButton: {
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "rgba(18,18,59,0.15)",
  },
  googleG: { fontSize: 16, fontWeight: "700", color: "#4285F4" },
  buttonText: { fontSize: 14, fontWeight: "600", color: "#12123B" },
  appleButton: { width: "100%", height: 46 },
});
