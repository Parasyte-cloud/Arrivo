import React, { useEffect } from "react";
import { View, Text, Pressable, StyleSheet, Platform, ActivityIndicator } from "react-native";
import Constants from "expo-constants";
import * as WebBrowser from "expo-web-browser";
import * as Google from "expo-auth-session/providers/google";
import * as AppleAuthentication from "expo-apple-authentication";
import { colors, spacing } from "../theme/tokens";
import { API_BASE_URL } from "../services/config";

// Needed once, at module load, so the in-app browser sheet Google sign-in
// opens actually closes itself and hands control back to the app when the
// redirect comes in — without this the browser can be left open after a
// successful sign-in.
WebBrowser.maybeCompleteAuthSession();

// Client IDs come from app.json's extra.googleOAuth — created in Google
// Cloud Console, one OAuth client per platform, specific to this app's own
// project/package (com.arrivo.driver), never shared with the rider app's.
const GOOGLE_IOS_CLIENT_ID = Constants.expoConfig?.extra?.googleOAuth?.iosClientId;
const GOOGLE_ANDROID_CLIENT_ID = Constants.expoConfig?.extra?.googleOAuth?.androidClientId;
const GOOGLE_WEB_CLIENT_ID = Constants.expoConfig?.extra?.googleOAuth?.webClientId;

// On iOS, Google's authorization server only accepts a redirect back to the
// app via a very specific "reversed client ID" URL scheme — it does NOT
// accept the app's own generic scheme (app.json's top-level "scheme"), which
// is what expo-auth-session falls back to if no redirectUri is given. That
// mismatch is exactly what threw "Error 400: redirect_uri_mismatch" on
// Google's own sign-in page. This scheme must also be registered as a
// CFBundleURLType in app.json's ios.infoPlist — both halves are required.
const GOOGLE_IOS_URL_SCHEME = GOOGLE_IOS_CLIENT_ID
  ? `com.googleusercontent.apps.${GOOGLE_IOS_CLIENT_ID.replace(".apps.googleusercontent.com", "")}`
  : undefined;

// Renders "Continue with Google" (both platforms) and "Sign in with Apple"
// (iOS only). `disabled` gates these behind the data-protection checkbox on
// the signup screen, exactly like "Create account" below them is gated.
// A sign-in that fails on the phone never reaches our server, so nothing would
// ever show up in the logs. Send the code Apple/Google gave to the same
// client-errors log the rider app uses, and show a short Ref to read out.
async function explain(stage, err, fallback) {
  const code = err && err.code ? String(err.code) : "";
  let ref = "";
  try {
    ref = "RA-" + Math.random().toString(36).slice(2, 8).toUpperCase();
    await fetch(`${API_BASE_URL}/api/client-errors`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Platform": `driver-${Platform.OS}` },
      body: JSON.stringify({ ref, code: "OAUTH_" + stage, message: (err && err.message) || fallback, detail: code, screen: "oauth", platform: `driver-${Platform.OS}`, context: { nativeCode: code || "none" } }),
    });
  } catch (e) { /* reporting is best effort */ }
  return `${fallback}${code || ref ? ` (${[code, ref && "Ref " + ref].filter(Boolean).join(", ")})` : ""}`;
}

export default function OAuthButtons({ onGoogleIdToken, onGoogleError, onAppleResult, onBlocked, disabled, busy }) {
  const googleConfigured = !!(GOOGLE_IOS_CLIENT_ID || GOOGLE_ANDROID_CLIENT_ID || GOOGLE_WEB_CLIENT_ID);

  const [request, response, promptAsync] = Google.useAuthRequest({
    iosClientId: GOOGLE_IOS_CLIENT_ID,
    androidClientId: GOOGLE_ANDROID_CLIENT_ID,
    webClientId: GOOGLE_WEB_CLIENT_ID,
    scopes: ["openid", "profile", "email"],
    // See GOOGLE_IOS_URL_SCHEME above — without this, iOS silently falls
    // back to a redirect URI Google's server rejects. Android's OAuth client
    // type validates via package name + signing certificate instead of a
    // redirect URI, so it doesn't need (or use) this.
    ...(Platform.OS === "ios" && GOOGLE_IOS_URL_SCHEME
      ? { redirectUri: `${GOOGLE_IOS_URL_SCHEME}:/oauthredirect` }
      : {}),
  });

  useEffect(() => {
    if (!response) return;
    // Previously only handled "success" and silently dropped everything
    // else — a real Google sign-in failure (bad client config, network
    // error) left the driver with zero feedback: no error text, spinner
    // just stops, nothing happens. "dismiss"/"cancel" (they backed out of
    // the picker themselves) is intentionally still silent here, matching
    // how the Apple handler below ignores ERR_REQUEST_CANCELED — only a
    // genuine "error" type is worth surfacing.
    if (response.type === "error") {
      explain("GOOGLE_RESPONSE", response.error || { code: response.params?.error }, response.error?.message || "Couldn't sign in with Google. Please try again.").then((m) => onGoogleError && onGoogleError(m));
      return;
    }
    if (response.type !== "success") return;
    const idToken = response.authentication?.idToken || response.params?.id_token;
    if (idToken) {
      onGoogleIdToken(idToken);
    } else {
      explain("GOOGLE_NO_TOKEN", { code: "no_id_token" }, "Couldn't complete Google sign-in. Please try again.").then((m) => onGoogleError && onGoogleError(m));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [response]);

  // Never a dead button. A button that ignores taps reads as "broken" to a
  // reviewer and to a driver alike, so a blocked tap says why instead.
  const handleGoogle = () => {
    if (disabled) { onBlocked && onBlocked(); return; }
    if (!request) { onGoogleError && onGoogleError("Google sign-in is still getting ready. Try again in a moment."); return; }
    promptAsync().catch((e) => {
      explain("GOOGLE_PROMPT", e, "Couldn't sign in with Google. Please try again.").then((m) => onGoogleError && onGoogleError(m));
    });
  };

  const handleAppleSignIn = async () => {
    if (disabled) { onBlocked && onBlocked(); return; }
    try {
      if (!(await AppleAuthentication.isAvailableAsync())) {
        onAppleResult({ error: await explain("APPLE_UNAVAILABLE", { code: "unavailable" }, "Sign in with Apple isn't available on this device.") });
        return;
      }
      const credential = await AppleAuthentication.signInAsync({
        requestedScopes: [
          AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
          AppleAuthentication.AppleAuthenticationScope.EMAIL,
        ],
      });
      // authorizationCode is one-time and only useful right now: the backend
      // swaps it for a refresh token, which is the only thing that can revoke
      // this Apple authorization when the account is deleted.
      if (!credential.identityToken) {
        onAppleResult({ error: await explain("APPLE_NO_TOKEN", { code: "no_identity_token" }, "Apple sign-in failed. Please try again.") });
        return;
      }
      onAppleResult({
        identityToken: credential.identityToken,
        fullName: credential.fullName,
        authorizationCode: credential.authorizationCode,
      });
    } catch (e) {
      if (e.code === "ERR_REQUEST_CANCELED") return;
      onAppleResult({ error: await explain("APPLE_SIGNIN", e, "Apple sign-in failed. Please try again.") });
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
              accessibilityRole="button"
              accessibilityLabel="Continue with Google"
              onPress={handleGoogle}
              style={[styles.button, styles.googleButton, disabled && styles.buttonDisabled]}
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
              onPress={handleAppleSignIn}
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
